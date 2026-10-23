import importlib.machinery
import importlib.util
import io
from http.client import IncompleteRead
import json
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from contextlib import redirect_stdout
from urllib.error import HTTPError, URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import provider_usage as providers
from quota_schema import public_snapshot

NOW = datetime(2026, 10, 23, 8, tzinfo=timezone.utc)


class ProviderTests(unittest.TestCase):
    def collector(self):
        loader = importlib.machinery.SourceFileLoader('quota_collect', str(Path(__file__).resolve().parents[1] / 'scripts/quota-collect'))
        spec = importlib.util.spec_from_loader(loader.name, loader)
        module = importlib.util.module_from_spec(spec)
        loader.exec_module(module)
        return module

    def test_claude_nested_logs_and_messages_without_ids(self):
        collect = self.collector()
        now = datetime.now(timezone.utc)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            nested = root / 'projects' / 'project' / 'session' / 'subagents'
            nested.mkdir(parents=True)
            log = {'timestamp': now.isoformat(), 'message': {'usage': {'input_tokens': 10, 'output_tokens': 2}}}
            rows = [log, {**log, 'uuid': 'second', 'message': {'usage': {'input_tokens': 20, 'output_tokens': 3}}}]
            (nested / 'agent.jsonl').write_text('\n'.join(map(json.dumps, rows)) + '\nnull\n{broken')
            with patch.object(collect, 'CLAUDE_HOME', root), patch.object(collect, 'account_quota', return_value={'quota_status': 'not_configured'}):
                result = collect.claude()
            self.assertIsNotNone(result)
            self.assertEqual(result['tokens_today'], 35)
            self.assertEqual(result['tokens_observed_at'], now.isoformat())

    def test_claude_quota_is_available_without_logs(self):
        collect = self.collector()
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(collect, 'CLAUDE_HOME', Path(tmp)), patch.object(collect, 'account_quota', return_value={
                    'quota_status': 'available', 'used_percent': 23, 'quota_observed_at': NOW.isoformat()}):
                result = collect.claude()
            self.assertEqual(result['used_percent'], 23)
            self.assertNotIn('tokens_today', result)

    def test_claude_old_and_new_windows(self):
        old = providers.claude_windows({'seven_day': {'utilization': 34, 'resets_at': '2026-10-30T00:00:00Z'},
                                       'five_hour': {'utilization': 0}})
        new = providers.claude_windows({'limits': [
            {'kind': 'session', 'percent': 0}, {'kind': 'weekly_all', 'percent': 34, 'resets_at': '2026-10-30T00:00:00Z'},
            {'kind': 'weekly_scoped', 'percent': 98, 'scope': {'model': {'display_name': 'private-model'}}}]})
        self.assertEqual(old, new)
        self.assertEqual([w['used_percent'] for w in old], [34, 0])
        self.assertEqual([w['window_minutes'] for w in old], [10080, 300])
        self.assertEqual(providers.claude_windows({'seven_day': {'utilization': None}}), [])

    def test_grok_current_and_legacy_credit_config(self):
        current = providers.grok_windows({'config': {'creditUsagePercent': 0, 'currentPeriod': {
            'type': 'USAGE_PERIOD_TYPE_WEEKLY', 'end': '2026-10-30T00:00:00Z'}}})
        self.assertEqual(current[0]['used_percent'], 0)
        self.assertEqual(current[0]['resets_at'], '2026-10-30T00:00:00+00:00')
        legacy = providers.grok_windows({'config': {'monthlyLimit': {'val': 2000}, 'used': {'val': 500},
                                                   'billingPeriodEnd': '2026-11-01T00:00:00Z'}})
        self.assertEqual(legacy[0]['used_percent'], 25)
        self.assertEqual(providers.grok_windows({'config': {}}), [])
        self.assertEqual(providers.grok_windows({'config': {'monthlyLimit': {'val': 0}, 'used': {}}}), [])

    def test_bad_quota_values_are_ignored(self):
        for value in (True, -1, 101, float('nan'), '20'):
            self.assertEqual(providers.claude_windows({'seven_day': {'utilization': value}}), [])
            self.assertEqual(providers.grok_windows({'config': {'creditUsagePercent': value}}), [])

    def test_read_only_requests_and_no_secret_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / '.credentials.json').write_text(json.dumps({'claudeAiOauth': {'accessToken': 'private-token'}}))
            response = io.BytesIO(json.dumps({'seven_day': {'utilization': 42}}).encode())
            with patch.object(providers, 'urlopen', return_value=response) as request:
                result = providers.account_quota('claude', root, NOW)
            req = request.call_args.args[0]
            self.assertEqual(req.get_method(), 'GET')
            self.assertEqual(req.full_url, 'https://api.anthropic.com/api/oauth/usage')
            self.assertEqual(req.get_header('Authorization'), 'Bearer private-token')
            self.assertEqual(result['used_percent'], 42)
            self.assertEqual(result['quota_observed_at'], NOW.isoformat())
            self.assertNotIn('private-', json.dumps(result))

    def test_grok_uses_only_subscription_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            auth = {'https://auth.x.ai::client': {'key': 'private-token', 'user_id': 'private-user',
                                                'expires_at': '2026-10-24T00:00:00Z'},
                    'xai::api_key': {'key': 'wrong-api-key'}}
            (root / 'auth.json').write_text(json.dumps(auth))
            with patch.object(providers, 'urlopen', return_value=io.BytesIO(b'{"config":{"creditUsagePercent":12}}')) as request:
                result = providers.account_quota('grok', root, NOW)
            req = request.call_args.args[0]
            self.assertEqual(req.full_url, 'https://cli-chat-proxy.grok.com/v1/billing?format=credits')
            self.assertEqual(req.get_header('X-xai-token-auth'), 'xai-grok-cli')
            self.assertEqual(req.get_header('Authorization'), 'Bearer private-token')
            self.assertEqual(result['used_percent'], 12)
            self.assertNotIn('private-', json.dumps(result))

    def test_unavailable_and_failed_queries_are_explicit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch.object(providers.sys, 'platform', 'linux'), patch.dict('os.environ', {}, clear=True):
                with patch.object(providers, 'urlopen') as request:
                    self.assertEqual(providers.account_quota('claude', root, NOW)['quota_status'], 'not_configured')
                    request.assert_not_called()
                (root / '.credentials.json').write_text('{"claudeAiOauth":{"accessToken":"private-token"}}')
                for error, status in [(URLError('private-error'), 'request_failed'),
                                      (HTTPError('private-url', 401, '', {}, None), 'auth_required'),
                                      (HTTPError('private-url', 429, '', {}, None), 'rate_limited')]:
                    with patch.object(providers, 'urlopen', side_effect=error):
                        result = providers.account_quota('claude', root, NOW)
                    self.assertEqual(result['quota_status'], status)
                    self.assertNotIn('private-', json.dumps(result))
                with patch.object(providers, 'urlopen', return_value=io.BytesIO(b'{"unexpected":true}')):
                    self.assertEqual(providers.account_quota('claude', root, NOW)['quota_status'], 'unsupported')

    def test_truncated_http_response_is_isolated(self):
        class BrokenResponse(io.BytesIO):
            def read(self, *args):
                raise IncompleteRead(b'private-body', 100)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / '.credentials.json').write_text('{"claudeAiOauth":{"accessToken":"private-token"}}')
            with patch.object(providers, 'urlopen', return_value=BrokenResponse()):
                result = providers.account_quota('claude', root, NOW)
            self.assertEqual(result, {'quota_status': 'request_failed'})

    def test_collector_to_public_snapshot_keeps_both_provider_readings(self):
        collect = self.collector()
        now = datetime.now(timezone.utc)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / '.credentials.json').write_text('{"claudeAiOauth":{"accessToken":"private-claude"}}')
            (root / 'auth.json').write_text('{"https://auth.x.ai::client":{"key":"private-grok"}}')
            session = root / 'sessions' / 'project' / 'session'
            session.mkdir(parents=True)
            (session / 'usage.json').write_text(json.dumps({'turns': [
                {'turnNumber': 1, 'endedAt': now.isoformat(), 'totalTokens': 4321, 'outputTokens': 10}]}))

            def response(request, **kwargs):
                return io.BytesIO(json.dumps({'seven_day': {'utilization': 0}, 'five_hour': {'utilization': 15}}
                    if 'anthropic' in request.full_url else {'config': {'creditUsagePercent': 12}}).encode())

            output = io.StringIO()
            with patch.object(collect, 'CODEX_HOME', root), patch.object(collect, 'CLAUDE_HOME', root), \
                    patch.object(collect, 'GROK_HOME', root), patch.object(collect, 'MACHINE', 'grok-cloud'), \
                    patch.object(collect, 'antigravity', return_value=None), patch.object(providers, 'urlopen', side_effect=response), \
                    patch.object(sys, 'argv', ['quota-collect']), redirect_stdout(output):
                collect.main()
            public = public_snapshot(json.loads(output.getvalue()))
            self.assertEqual(public['claude']['used_percent'], 0)
            self.assertEqual(public['claude']['windows'][1]['used_percent'], 15)
            self.assertEqual(public['grok']['used_percent'], 12)
            self.assertEqual(public['grok']['tokens_today'], 4321)
            self.assertNotIn('private-', json.dumps(public))

    def test_grok_turn_files_win_over_updates_without_double_counting(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            session = root / 'sessions' / 'project' / 'session'
            session.mkdir(parents=True)
            rows = [{'turnNumber': 1, 'endedAt': (NOW - timedelta(hours=1)).isoformat(),
                     'inputTokens': 100, 'outputTokens': 10, 'totalTokens': 110, 'cachedReadTokens': 80},
                    {'turnNumber': 2, 'endedAt': NOW.isoformat(), 'totalTokens': 50, 'outputTokens': 5}]
            (session / 'usage.json').write_text(json.dumps({'turns': rows, 'session': {'totalTokens': 160}}))
            event = {'timestamp': NOW.timestamp(), 'params': {'update': {'sessionUpdate': 'turn_completed',
                     'usage': {'totalTokens': 900, 'outputTokens': 100}}}}
            (session / 'updates.jsonl').write_text(json.dumps(event) + '\n')
            result = providers.grok_tokens(root, NOW)
            self.assertEqual(result['tokens_today'], 160)
            self.assertEqual(result['output_tokens_today'], 15)
            self.assertEqual(result['tokens_last_5h'], 160)
            self.assertEqual(result['tokens_observed_at'], NOW.isoformat())

    def test_grok_old_completed_updates_deduplicate_event_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            session = root / 'sessions' / 'project' / 'session'
            session.mkdir(parents=True)
            event = {'timestamp': NOW.timestamp(), 'params': {'_meta': {'eventId': 'event-1'},
                     'update': {'sessionUpdate': 'turn_completed', 'usage': {'inputTokens': 100, 'outputTokens': 20,
                                                                          'cachedReadTokens': 80, 'totalTokens': 120}}}}
            (session / 'updates.jsonl').write_text('\n'.join([json.dumps(event)] * 2) + '\n{broken\nnull\n')
            result = providers.grok_tokens(root, NOW)
            self.assertEqual(result['tokens_today'], 120)
            self.assertEqual(providers.grok_tokens(root, NOW + timedelta(days=1))['tokens_today'], 0)

    def test_missing_grok_logs_remain_unknown(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(providers.grok_tokens(Path(tmp), NOW))

    def test_public_snapshot_preserves_quota_and_separate_timestamps(self):
        raw = {'machine': 'grok-cloud', 'collected_at': NOW.isoformat(), 'grok': {
            'used_percent': 15, 'resets_at': '2026-10-30T00:00:00Z', 'quota_status': 'available',
            'quota_observed_at': NOW.isoformat(), 'tokens_observed_at': '2026-10-22T00:00:00Z',
            'observed_at': NOW.isoformat(), 'tokens_today': 42,
            'windows': [{'used_percent': 15, 'window_minutes': 10080, 'resets_at': '2026-10-30T00:00:00Z'}],
            'authorization': 'private-token', 'account': 'private-user'}}
        result = public_snapshot(raw)
        self.assertEqual(result['grok']['used_percent'], 15)
        self.assertEqual(result['grok']['windows'][0]['window_minutes'], 10080)
        self.assertEqual(result['grok']['tokens_observed_at'], '2026-10-22T00:00:00+00:00')
        self.assertEqual(result['grok']['quota_status'], 'available')
        self.assertNotIn('private-', json.dumps(result))

    def test_unknown_group_fields_cannot_leak_through_subscription_pools(self):
        raw = {'machine': 'mac', 'collected_at': NOW.isoformat(), 'claude': {
            'used_percent': 20, 'group': 'private-account',
            'windows': [{'used_percent': 20, 'window_minutes': 300, 'group': 'private-host'}]}}
        self.assertNotIn('private-', json.dumps(public_snapshot(raw)))

    def test_expired_auth_never_makes_a_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / '.credentials.json').write_text(json.dumps({'claudeAiOauth': {
                'accessToken': 'private-token', 'expiresAt': (NOW - timedelta(hours=1)).timestamp() * 1000}}))
            with patch.object(providers, 'urlopen') as request:
                self.assertEqual(providers.account_quota('claude', root, NOW)['quota_status'], 'auth_required')
                request.assert_not_called()

    def test_mac_keychain_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            completed = subprocess.CompletedProcess([], 0, stdout='{"claudeAiOauth":{"accessToken":"private-token"}}')
            with patch.object(providers.sys, 'platform', 'darwin'), patch.dict('os.environ', {}, clear=True):
                with patch.object(providers.subprocess, 'run', return_value=completed) as security:
                    result = providers.credentials('claude', Path(tmp))
            self.assertEqual(result['accessToken'], 'private-token')
            self.assertEqual(security.call_args.args[0][0], 'security')

    def test_mac_keychain_wins_over_stale_plaintext_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / '.credentials.json').write_text('{"claudeAiOauth":{"accessToken":"stale-token","expiresAt":1}}')
            completed = subprocess.CompletedProcess([], 0, stdout='{"claudeAiOauth":{"accessToken":"current-token"}}')
            with patch.object(providers.sys, 'platform', 'darwin'), patch.dict('os.environ', {}, clear=True), \
                    patch.object(providers.subprocess, 'run', return_value=completed), \
                    patch.object(providers, 'urlopen', return_value=io.BytesIO(b'{"seven_day":{"utilization":21},"five_hour":{"utilization":7}}')) as request:
                result = providers.account_quota('claude', root, NOW)
            self.assertEqual(result['quota_status'], 'available')
            self.assertEqual([w['used_percent'] for w in result['windows']], [21, 7])
            self.assertEqual(request.call_args.args[0].get_header('Authorization'), 'Bearer current-token')

    def test_mac_keychain_uses_selected_config_directory(self):
        # The CLI hashes the literal directory setting; do not normalize it as a path.
        for env, expected in [
            ({'CLAUDE_CONFIG_DIR': '/profiles/work'}, 'Claude Code-credentials-2ea9e238'),
            ({'CLAUDE_CONFIG_DIR': '/profiles/work', 'CLAUDE_SECURESTORAGE_CONFIG_DIR': ''}, 'Claude Code-credentials'),
            ({'CLAUDE_CONFIG_DIR': '/profiles/other', 'CLAUDE_SECURESTORAGE_CONFIG_DIR': '/profiles/work'}, 'Claude Code-credentials-2ea9e238'),
        ]:
            with self.subTest(env=env), tempfile.TemporaryDirectory() as tmp:
                completed = subprocess.CompletedProcess([], 0, stdout='{"claudeAiOauth":{"accessToken":"private-token"}}')
                with patch.object(providers.sys, 'platform', 'darwin'), patch.dict('os.environ', env, clear=True), \
                        patch.object(providers.subprocess, 'run', return_value=completed) as security:
                    providers.credentials('claude', Path(tmp))
                self.assertEqual(security.call_args.args[0][3], expected)

    def test_mac_keychain_unavailable_uses_plaintext_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / '.credentials.json').write_text('{"claudeAiOauth":{"accessToken":"file-token"}}')
            with patch.object(providers.sys, 'platform', 'darwin'), patch.dict('os.environ', {}, clear=True), \
                    patch.object(providers.subprocess, 'run', side_effect=subprocess.CalledProcessError(44, 'security')):
                result = providers.credentials('claude', root)
            self.assertEqual(result['accessToken'], 'file-token')

    def test_secure_storage_override_reads_selected_file_without_moving_logs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            storage = root / 'auth'
            storage.mkdir()
            (root / '.credentials.json').write_text('{"claudeAiOauth":{"accessToken":"wrong-account"}}')
            (storage / '.credentials.json').write_text('{"claudeAiOauth":{"accessToken":"selected-account"}}')
            with patch.object(providers.sys, 'platform', 'linux'), \
                    patch.dict('os.environ', {'CLAUDE_SECURESTORAGE_CONFIG_DIR': str(storage)}, clear=True):
                result = providers.credentials('claude', root)
            self.assertEqual(result['accessToken'], 'selected-account')


if __name__ == '__main__':
    unittest.main()

"""Read-only subscription meters and Grok Build logs; never return credentials.

These internal usage APIs are also used by the installed clients. Unknown
responses stay unavailable. No model prompts, login flows or token refreshes.
"""
import hashlib
import json
import math
import os
from http.client import HTTPException
from pathlib import Path
import subprocess
import sys
import unicodedata
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

TZ = timezone(timedelta(hours=8))
QUOTA_STATUSES = frozenset(('available', 'not_configured', 'auth_required',
                            'request_failed', 'rate_limited', 'unsupported'))


def timestamp(value):
    if isinstance(value, bool):
        raise ValueError('invalid timestamp')
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, timezone.utc)
    dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if dt.tzinfo is None:
        raise ValueError('timezone required')
    return dt.astimezone(timezone.utc)


def valid_number(value, maximum=None):
    return (not isinstance(value, bool) and isinstance(value, (int, float))
            and math.isfinite(value) and value >= 0 and (maximum is None or value <= maximum))


def window(pct, reset=None, minutes=None):
    if not valid_number(pct, 100):
        return None
    try:
        reset = timestamp(reset).isoformat() if reset else None
    except (ValueError, TypeError, AttributeError, OverflowError):
        reset = None
    return dict(used_percent=pct, resets_at=reset, window_minutes=minutes)


def claude_windows(raw):
    out = []
    limits = raw.get('limits')
    for key, kind, minutes in (('seven_day', 'weekly_all', 10080), ('five_hour', 'session', 300)):
        entry = raw.get(key)
        if isinstance(entry, dict):
            w = window(entry.get('utilization'), entry.get('resets_at'), minutes)
        else:
            entry = next((x for x in limits if isinstance(x, dict) and x.get('kind') == kind), None) if isinstance(limits, list) else None
            w = window(entry.get('percent'), entry.get('resets_at'), minutes) if entry else None
        if w:
            out.append(w)
    return out


def grok_windows(raw):
    config = raw.get('config')
    if not isinstance(config, dict):
        return []
    pct = config.get('creditUsagePercent')
    period = config.get('currentPeriod') or {}
    if not isinstance(period, dict):
        period = {}
    reset = period.get('end') or config.get('billingPeriodEnd')
    if pct is None:
        limit, used = config.get('monthlyLimit'), config.get('used')
        # A present proto Cent {} means zero; an absent Cent means unknown.
        if isinstance(limit, dict) and isinstance(used, dict):
            limit, used = limit.get('val', 0), used.get('val', 0)
            if valid_number(limit) and limit > 0 and valid_number(used):
                pct = used / limit * 100
    minutes = 10080 if period.get('type') == 'USAGE_PERIOD_TYPE_WEEKLY' else None
    w = window(pct, reset, minutes)
    return [w] if w else []


def read_json(path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None


def credentials(provider, root):
    if provider == 'claude':
        token = os.environ.get('CLAUDE_CODE_OAUTH_TOKEN')
        if token:
            return {'accessToken': token}
        # Match the CLI's store selection, including an explicitly empty override.
        # The Keychain suffix hashes the literal setting (NFC), not a resolved path.
        selected = os.environ.get('CLAUDE_SECURESTORAGE_CONFIG_DIR', os.environ.get('CLAUDE_CONFIG_DIR'))
        storage = root
        if 'CLAUDE_SECURESTORAGE_CONFIG_DIR' in os.environ:
            storage = Path(selected) if selected else Path.home() / '.claude'
        raw = None
        if sys.platform == 'darwin':
            service = 'Claude Code-credentials'
            if selected:
                service += '-' + hashlib.sha256(unicodedata.normalize('NFC', selected).encode('utf-8')).hexdigest()[:8]
            try:
                result = subprocess.run(['security', 'find-generic-password', '-s', service, '-w'],
                                        capture_output=True, text=True, timeout=5, check=True)
                raw = json.loads(result.stdout)
            except (OSError, ValueError, subprocess.SubprocessError):
                pass
        if not isinstance(raw, dict):
            raw = read_json(storage / '.credentials.json')
        return raw.get('claudeAiOauth') if isinstance(raw, dict) else None
    raw = read_json(root / 'auth.json')
    if not isinstance(raw, dict):
        return None
    candidates = [v for k, v in raw.items() if isinstance(v, dict) and v.get('key')
                  and (k.startswith('https://auth.x.ai::') or k == 'https://accounts.x.ai/sign-in')]
    # Do not guess which account is active in a multi-account store.
    return candidates[0] if len(candidates) == 1 else None


def account_quota(provider, root, now=None):
    now = now or datetime.now(timezone.utc)
    unavailable = lambda status: {'quota_status': status}
    auth = credentials(provider, root)
    if not isinstance(auth, dict):
        return unavailable('not_configured')
    token = auth.get('accessToken' if provider == 'claude' else 'key')
    if not isinstance(token, str) or not token:
        return unavailable('not_configured')
    try:
        expiry = auth.get('expiresAt' if provider == 'claude' else 'expires_at')
        if expiry and (timestamp(expiry / 1000 if provider == 'claude' else expiry) <= now):
            return unavailable('auth_required')
        headers = {'Authorization': f'Bearer {token}', 'Accept': 'application/json'}
        if provider == 'claude':
            url = 'https://api.anthropic.com/api/oauth/usage'
            headers['anthropic-beta'] = 'oauth-2025-04-20'
        else:
            url = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'
            headers['X-XAI-Token-Auth'] = 'xai-grok-cli'
            if auth.get('user_id'):
                headers['x-userid'] = auth['user_id']
            version = read_json(root / 'version.json')
            if isinstance(version, dict) and isinstance(version.get('version'), str):
                headers['x-grok-client-version'] = version['version']
        with urlopen(Request(url, headers=headers), timeout=15) as response:
            raw = json.load(response)
        windows = (claude_windows if provider == 'claude' else grok_windows)(raw) if isinstance(raw, dict) else []
        if not windows:
            return unavailable('unsupported')
        return dict(quota_status='available', quota_observed_at=now.isoformat(),
                    observed_at=now.isoformat(), windows=windows,
                    used_percent=windows[0]['used_percent'], resets_at=windows[0]['resets_at'])
    except HTTPError as error:
        return unavailable('auth_required' if error.code in (401, 403) else 'rate_limited' if error.code == 429 else 'request_failed')
    except (OSError, URLError, HTTPException, ValueError, TypeError, AttributeError, OverflowError):
        # Never print exception strings: upstream bodies/URLs can contain secrets.
        return unavailable('request_failed')


def json_lines(path):
    try:
        with path.open(encoding='utf-8', errors='replace') as stream:
            for line in stream:
                try:
                    value = json.loads(line)
                    if isinstance(value, dict):
                        yield value
                except ValueError:
                    continue
    except OSError:
        return


def grok_tokens(root, now=None):
    now = now or datetime.now(timezone.utc)
    days = {(now.astimezone(TZ) - timedelta(days=i)).strftime('%Y-%m-%d'): [0, 0] for i in range(7)}
    newest = None
    last5h = 0
    sessions = root / 'sessions'
    folders = sorted({p.parent for pattern in ('*/*/usage.json', '*/*/updates.jsonl') for p in sessions.glob(pattern)})
    for folder in folders:
        usage = read_json(folder / 'usage.json')
        turns = usage.get('turns') if isinstance(usage, dict) else None
        records = []
        if isinstance(turns, list) and turns:
            unique = {r.get('turnNumber', i): r for i, r in enumerate(turns) if isinstance(r, dict)}
            records = [(r.get('endedAt'), r) for r in unique.values()]
        else:
            seen = set()
            for event in json_lines(folder / 'updates.jsonl'):
                params = event.get('params')
                if not isinstance(params, dict):
                    continue
                update = params.get('update')
                if not isinstance(update, dict) or update.get('sessionUpdate') != 'turn_completed':
                    continue
                meta = params.get('_meta') or {}
                key = meta.get('eventId') if isinstance(meta, dict) else None
                key = key or json.dumps(event, sort_keys=True)
                if key in seen:
                    continue
                seen.add(key)
                records.append((event.get('timestamp'), update.get('usage')))
        for at, row in records:
            if not isinstance(row, dict):
                continue
            total, output = row.get('totalTokens'), row.get('outputTokens')
            if not valid_number(total) or not valid_number(output):
                continue
            try:
                t = timestamp(at)
            except (ValueError, TypeError, AttributeError, OverflowError, OSError):
                continue
            if t > now or t < now - timedelta(days=7):
                continue
            day = t.astimezone(TZ).strftime('%Y-%m-%d')
            if day not in days:
                continue
            days[day][0] += total
            days[day][1] += output
            if t >= now - timedelta(hours=5):
                last5h += total
            newest = max(newest or t, t)
    if newest is None:
        return None
    today = now.astimezone(TZ).strftime('%Y-%m-%d')
    return dict(observed_at=newest.isoformat(), tokens_observed_at=newest.isoformat(),
                tokens_last_5h=last5h, tokens_today=days[today][0], output_tokens_today=days[today][1],
                tokens_by_day=[dict(day=k, tokens=v[0], output_tokens=v[1]) for k, v in sorted(days.items())])

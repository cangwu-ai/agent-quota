import importlib.machinery
import json
from pathlib import Path
import subprocess
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from quota_schema import public_snapshot, public_manual


class PipelineTests(unittest.TestCase):
    def test_existing_snapshots_and_privacy(self):
        for source in ('mac', 'grok-cloud'):
            raw = json.loads(subprocess.check_output(['git', 'show', f'origin/data:data/{source}.json']))
            raw['host'] = 'private-host'
            raw['codex']['account'] = 'private-account'
            result = public_snapshot(raw)
            self.assertNotIn('private-', json.dumps(result))
            self.assertEqual(result['updated_at'], raw['collected_at'])
            for p in result['pools']:
                if p['used_pct'] is not None:
                    self.assertAlmostEqual(p['used_pct'] + p['remaining_pct'], 100)
                if p['provider'] in ('antigravity', 'grok'):
                    self.assertIsNone(p['tokens'])

    def test_invalid_inputs(self):
        for value in (-1, 101, float('nan'), True):
            with self.assertRaises(ValueError):
                public_manual({'grok': dict(used_percent=value)})
        with self.assertRaises(ValueError):
            public_snapshot(dict(machine='private-host', collected_at='2026-10-20T00:00:00Z'))

    def test_manual_compatibility(self):
        result = public_manual({'grok': dict(used_percent=20, updated_at='2026-10-20T08:00:00+08:00', tokens=123)})
        self.assertEqual(result['grok']['used_percent'], 20)
        self.assertEqual(result['pools'][0]['tokens'], 123)
        self.assertEqual(result['grok']['updated_at'], '2026-10-20T00:00:00+00:00')
        self.assertIn('updated_at', public_manual({}))


if __name__ == '__main__':
    unittest.main()

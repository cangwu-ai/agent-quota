#!/usr/bin/env python3
"""Read-only audit of a local data ref. Never fetches or publishes."""
import argparse
import json
import re
import subprocess
from datetime import datetime


def git(*args):
    return subprocess.check_output(['git', *args], text=True)


def audit(ref):
    report = {'ref': git('rev-parse', ref).strip(), 'files': {}, 'mac_history': {}}
    for name in ('mac', 'grok-cloud', 'manual'):
        body = git('show', f'{ref}:data/{name}.json')
        obj = json.loads(body)
        leaks = bool(re.search(r'/Users/|/home/|/workspace/|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|"host"\s*:', body))
        collected = obj.get('collected_at')
        commit = git('log', '-1', '--format=%cI', ref, '--', f'data/{name}.json').strip()
        report['files'][name] = dict(updated_at=obj.get('updated_at'), privacy_pass=not leaks,
            collect_to_commit_seconds=(datetime.fromisoformat(commit)-datetime.fromisoformat(collected)).total_seconds() if collected else None)
    rows = git('log', '-100', '--format=%H %cI', ref, '--', 'data/mac.json').splitlines()
    times = [datetime.fromisoformat(row.split()[1]) for row in rows]
    # Include the first predecessor at least one hour before the latest commit.
    end = next((i for i, t in enumerate(times) if (times[0]-t).total_seconds() >= 3600), None) if times else None
    if end is not None:
        selected = times[:end+1]
        gaps = [(a-b).total_seconds() for a,b in zip(selected, selected[1:])]
        report['mac_history'] = dict(start=selected[-1].isoformat(), end=selected[0].isoformat(),
            intervals=len(gaps), maximum_gap_seconds=max(gaps), passed=all(0 < x <= 1800 for x in gaps),
            evidence='historical commits; not a live observation or Pages deployment proof')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--ref', default='origin/data')
    print(json.dumps(audit(parser.parse_args().ref), ensure_ascii=False, indent=2))

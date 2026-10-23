"""Public allowlist and additive schema; unknown usage is never converted to zero."""
from datetime import datetime, timezone
import math
from provider_usage import QUOTA_STATUSES


def utc(value):
    dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if dt.tzinfo is None:
        raise ValueError('timestamp requires timezone')
    return dt.astimezone(timezone.utc).isoformat()


def number(value, maximum=None):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError('invalid usage')
    if maximum is not None and value > maximum:
        raise ValueError('percentage exceeds 100')
    return value


def pool(provider, ident, name, pct, tokens, observed):
    pct = number(pct, 100)
    return dict(id=ident, name=name, provider=provider, used_pct=pct,
                remaining_pct=None if pct is None else round(100-pct, 6),
                tokens=number(tokens), tokens_period='today' if tokens is not None else None,
                tokens_status='available' if tokens is not None else 'unavailable',
                updated_at=utc(observed) if observed else None)


def public_snapshot(snap):
    source = snap['machine']
    if source not in ('mac', 'grok-cloud'):
        raise ValueError('unknown source')
    collected = utc(snap['collected_at'])
    result = dict(schema_version=1, machine=source, collected_at=collected,
                  updated_at=collected, pools=[])
    for provider in ('codex', 'claude', 'antigravity', 'grok'):
        raw = snap.get(provider)
        if not raw:
            result[provider] = None
            result['pools'].append(pool(provider, provider, provider.title(), None, None, None))
            continue
        clean = {}
        for key in ('observed_at', 'quota_observed_at', 'tokens_observed_at'):
            if raw.get(key):
                clean[key] = utc(raw[key])
        if provider in ('claude', 'grok'):
            if raw.get('quota_status') in QUOTA_STATUSES:
                clean['quota_status'] = raw['quota_status']
            if 'used_percent' in raw:
                clean['used_percent'] = number(raw['used_percent'], 100)
            if raw.get('resets_at'):
                clean['resets_at'] = utc(raw['resets_at'])
        for key in ('tokens_last_5h', 'tokens_today', 'output_tokens_today', 'output_tokens_7d'):
            if key in raw:
                clean[key] = number(raw[key])
        if 'tokens_by_day' in raw:
            clean['tokens_by_day'] = [dict(day=datetime.strptime(d['day'], '%Y-%m-%d').strftime('%Y-%m-%d'),
                tokens=number(d['tokens']), output_tokens=number(d.get('output_tokens'))) for d in raw['tokens_by_day']]
        has_windows = provider in ('codex', 'claude', 'grok') and isinstance(raw.get('windows'), list) and bool(raw['windows'])
        entries = raw['windows'] if has_windows else raw.get('buckets', []) if provider == 'antigravity' else [raw]
        safe_entries = []
        for entry in entries:
            # Only fixed provider group names can reach the public output.
            group = entry.get('group') if provider == 'antigravity' else None
            if provider == 'antigravity' and group not in ('Gemini Models', 'Claude and GPT models'):
                raise ValueError('unknown model group')
            window = entry.get('window') if provider == 'antigravity' else entry.get('window_minutes') if has_windows else None
            if provider == 'antigravity' and window not in ('weekly', '5h'):
                raise ValueError('unknown window')
            if has_windows:
                number(window)
            ident = provider + (f':{group}:{window}' if group else f':{window}' if window is not None else '')
            p = pool(provider, ident, group or provider.title(), entry.get('used_percent'), raw.get('tokens_today'), raw.get('quota_observed_at') or raw.get('observed_at'))
            p['resets_at'] = utc(entry['resets_at']) if entry.get('resets_at') else None
            p['tokens_scope'] = 'provider-source'  # shared by windows, never sum these values
            result['pools'].append(p)
            e = dict(used_percent=p['used_pct'], resets_at=p['resets_at'])
            if has_windows:
                e['window_minutes'] = window
            elif provider == 'antigravity':
                e.update(group=group, window=window)
            safe_entries.append(e)
        if has_windows or provider in ('codex', 'antigravity'):
            clean['buckets' if provider == 'antigravity' else 'windows'] = safe_entries
        result[provider] = clean
    return result


def public_manual(raw):
    result = dict(schema_version=1, updated_at=datetime.now(timezone.utc).isoformat(), pools=[])
    for provider in ('claude', 'grok', 'antigravity'):
        item = raw.get(provider)
        if not item:
            continue
        p = pool(provider, provider, provider.title(), item.get('used_percent'), item.get('tokens'), item.get('updated_at'))
        reset = item.get('resets_on')
        if reset:
            reset = datetime.strptime(reset, '%Y-%m-%d').strftime('%Y-%m-%d')
        result[provider] = dict(used_percent=p['used_pct'], resets_on=reset, updated_at=p['updated_at'], tokens=p['tokens'])
        result['pools'].append(p)
    return result

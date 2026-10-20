import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createQuotaLoader } from '../frontend/quota-data.mjs';
import {
  buildCards, buildDays, sumCardTokens, headerStatus, formatCompact, formatExact, quotaLevel, staleOf, relativeTime, untilTime,
} from '../frontend/dashboard-model.mjs';

const now = Date.parse('2026-10-20T12:00:00Z');
const fixtures = Object.fromEntries(await Promise.all(['mac', 'grok-cloud', 'manual'].map(async key => [key, JSON.parse(await readFile(new URL(`./fixtures/quota/${key}.json`, import.meta.url)))])));
function loaderFor(files, time = now) {
  return createQuotaLoader({ now: () => time, fetch: async url => {
    const key = new URL(url).pathname.split('/').at(-1).replace('.json', '');
    if (files[key] instanceof Error) throw files[key];
    return { ok: !!files[key], status: files[key] ? 200 : 404, json: async () => files[key] };
  } });
}

test('one card per known provider in display order; card tokens sum to totalTokens', async () => {
  const result = await loaderFor(structuredClone(fixtures))();
  const cards = buildCards(result.pools, now);
  assert.deepEqual(cards.map(c => c.provider), ['codex', 'claude', 'grok', 'antigravity']);
  assert.deepEqual(cards.map(c => c.tokens), [150, 200, 30, null]);
  assert.equal(sumCardTokens(cards), result.totalTokens);
  const codex = cards[0];
  assert.equal(codex.usedPct, 20);
  assert.equal(codex.remainingPct, 80);
  assert.equal(codex.shortPct, 10);
  assert.equal(codex.windowLabel, '本周');
  assert.equal(cards[2].manual, true);
  assert.equal(cards[3].usedPct, null);
  assert.equal(cards[3].level, 'none');
});

test('legacy snapshot shape from card 01 (sanitized) renders and sums correctly', async () => {
  const mac = {
    collected_at: '2026-10-20T11:55:00+00:00',
    codex: { observed_at: '2026-10-20T11:50:00Z', windows: [{ used_percent: 4.0, window_minutes: 10080, resets_at: '2026-10-26T06:06:20+00:00' }] },
    claude: { observed_at: '2026-10-20T11:55:00Z', tokens_today: 26334378,
      tokens_by_day: [{ day: '2026-10-19', tokens: 29144736 }, { day: '2026-10-20', tokens: 26334378 }] },
  };
  const result = await loaderFor({ mac, 'grok-cloud': null, manual: null })();
  const cards = buildCards(result.pools, now);
  assert.equal(result.totalTokens, 26334378);
  assert.equal(sumCardTokens(cards), result.totalTokens);
  const codex = cards.find(c => c.provider === 'codex');
  assert.equal(codex.usedPct, 4);
  assert.equal(codex.windowLabel, '本周');
  assert.equal(codex.tokens, null);
  assert.deepEqual(buildDays(cards).map(d => d.total), [29144736, 26334378]);
});

test('unknown providers are appended and still counted', async () => {
  const files = structuredClone(fixtures);
  files.mac.pools.push({ id: 'gemini', provider: 'gemini', name: 'Gemini', used_pct: 70, tokens: 5, tokens_period: 'today', updated_at: '2026-10-20T12:00:00Z' });
  const result = await loaderFor(files)();
  const cards = buildCards(result.pools, now);
  assert.equal(cards.at(-1).provider, 'gemini');
  assert.equal(cards.at(-1).level, 'warn');
  assert.equal(sumCardTokens(cards), result.totalTokens);
});

test('no data at all still yields placeholder cards', () => {
  const cards = buildCards([], now);
  assert.equal(cards.length, 4);
  assert.ok(cards.every(c => c.usedPct == null && c.tokens == null));
  assert.equal(sumCardTokens(cards), 0);
  assert.deepEqual(buildDays(cards), []);
});

test('header freshness uses newest automatic source; offline keeps stale data visible', async () => {
  const fresh = await loaderFor(structuredClone(fixtures))();
  assert.equal(headerStatus(fresh, now).staleLevel, 'fresh');
  assert.equal(headerStatus(fresh, now + 45 * 60000).staleLevel, 'warning');
  assert.equal(headerStatus(fresh, now + 61 * 60000).staleLevel, 'critical');

  // Cold start while offline: every source fails, page gets an empty but well-formed result.
  const offline = await loaderFor({ mac: new Error('offline'), 'grok-cloud': new Error('offline'), manual: new Error('offline') })();
  const head = headerStatus(offline, now);
  assert.equal(head.hasData, false);
  assert.equal(head.updatedAt, null);
  assert.equal(head.staleLevel, 'critical');
  assert.ok(head.sources.every(s => s.failed));
  assert.equal(headerStatus(null, now).hasData, false);
});

test('number formatting: thousands separators, K/M/B with unit rounding', () => {
  assert.equal(formatExact(26334378), '26,334,378');
  assert.equal(formatExact(null), '—');
  assert.deepEqual(formatCompact(99999), ['99,999', '']);
  assert.deepEqual(formatCompact(100000), ['100', 'K']);
  assert.deepEqual(formatCompact(26334378), ['26.3', 'M']);
  assert.deepEqual(formatCompact(999960), ['1.00', 'M']);
  assert.deepEqual(formatCompact(1.5e9), ['1.50', 'B']);
  assert.deepEqual(formatCompact(null), ['—', '']);
});

test('levels, staleness and time labels', () => {
  assert.deepEqual([null, 0, 59.9, 60, 79.9, 80, 100].map(quotaLevel), ['none', 'good', 'good', 'warn', 'warn', 'crit', 'crit']);
  const at = m => new Date(now - m * 60000).toISOString();
  assert.deepEqual([0, 30, 31, 60, 61].map(m => staleOf(at(m), now)), ['fresh', 'fresh', 'warning', 'warning', 'critical']);
  assert.equal(staleOf(null, now), 'critical');
  assert.equal(relativeTime(at(0.2), now), '刚刚');
  assert.equal(relativeTime(at(12), now), '12 分钟前');
  assert.equal(relativeTime(at(180), now), '3 小时前');
  assert.equal(relativeTime(null, now), '无数据');
  assert.equal(untilTime(new Date(now + (3 * 24 + 14) * 3600000).toISOString(), now), '3 天 14 时');
  assert.equal(untilTime(new Date(now - 1).toISOString(), now), '已重置');
});

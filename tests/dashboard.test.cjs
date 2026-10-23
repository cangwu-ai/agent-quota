const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const published = JSON.parse(readFileSync('tests/fixtures/quota/subscriptions.json', 'utf8'));

const modules = Promise.all([import('../frontend/quota-data.mjs'), import('../frontend/dashboard-model.mjs')]);
const now = Date.parse('2026-10-23T12:00:00Z');
const fresh = '2026-10-23T12:00:00Z';
const before = '2026-10-23T11:00:00Z';
const past = '2026-10-21T12:00:00Z';
const future = '2026-10-24T12:00:00Z';

async function dashboard(data = {}, time = now) {
  const [{ createQuotaLoader }, { buildCards, buildDays, headerStatus }] = await modules;
  const files = { mac: {}, 'grok-cloud': {}, manual: {}, ...data };
  const load = createQuotaLoader({ now: () => time, fetch: async url => {
    const source = new URL(url).pathname.split('/').at(-1).replace('.json', '');
    if (files[source] instanceof Error) throw files[source];
    return { ok: true, json: async () => files[source] };
  } });
  async function refresh() {
    const result = await load();
    const cards = buildCards(result.pools, time);
    return { result, cards, card: key => cards.find(c => c.provider === key),
      days: buildDays(cards), header: headerStatus(result, time, cards) };
  }
  return { ...await refresh(), files, refresh };
}

test('Claude publisher windows retain weekly zero and separate five-hour reading', async () => {
  const p = await dashboard({ mac: published.weekly });
  assert.equal(p.card('claude').usedPct, 0);
  assert.equal(p.card('claude').shortPct, 20);
  assert.equal(p.card('claude').windowLabel, '本周');
});

test('Grok chooses newest account reading, including a newer manual zero fallback', async () => {
  const p = await dashboard({ mac: { grok: { used_percent: 10, quota_observed_at: before } },
    'grok-cloud': { grok: { used_percent: 25, quota_observed_at: fresh } },
    manual: { grok: { used_percent: 90, updated_at: past } } });
  assert.equal(p.card('grok').usedPct, 25);
  p.files.manual = published.manualZero;
  const updated = await p.refresh();
  assert.equal(updated.card('grok').usedPct, 0);
  assert.equal(updated.card('grok').manual, true);
});

test('published Grok tokens and history survive an expired login', async () => {
  const p = await dashboard({ 'grok-cloud': published.grokLogin });
  assert.equal(p.card('grok').tokens, 1234);
  assert.equal(p.result.totalTokens, 1234);
  assert.deepEqual(p.days.map(d => d.total), [1234]);
  assert.match(p.card('grok').reason, /登录/);
});

test('Claude logs remain visible when the percentage is unknown', async () => {
  const p = await dashboard({ mac: { collected_at: fresh, claude: { tokens_today: 321, observed_at: fresh } } });
  assert.equal(p.card('claude').tokens, 321);
  assert.equal(p.card('claude').usedPct, null);
  assert.match(p.card('claude').reason, /仅有 token/);
});

test('expired subscription periods stay unknown; old readings still raise stale status', async () => {
  const p = await dashboard({ mac: { claude: { used_percent: 20, quota_observed_at: before, resets_at: future } },
    'grok-cloud': { grok: { used_percent: 75, quota_observed_at: past, resets_at: past } } });
  assert.equal(p.card('claude').stale, 'warning');
  assert.equal(p.card('grok').usedPct, null);
  assert.match(p.card('grok').reason, /周期已结束/);
});

test('fresh quota response cannot relabel yesterday tokens as today', async () => {
  const p = await dashboard({ mac: published.yesterday });
  assert.equal(p.card('claude').tokens, null);
  assert.equal(p.result.totalTokens, 0);
  assert.equal(p.days[0].total, 999); // Still visible in the seven-day history.
});

test('history older than seven Beijing calendar days is excluded', async () => {
  const p = await dashboard({ mac: { collected_at: past, claude: { tokens_today: 999,
    tokens_by_day: [{ day: '2026-10-01', tokens: 999 }, { day: '2026-10-24', tokens: 50 }] } } });
  assert.deepEqual(p.days, []);
});

test('manual token fallback counts only on its recorded Beijing day; auto tokens win', async () => {
  const p = await dashboard({ manual: published.manualTokens });
  assert.equal(p.card('grok').tokens, 444);
  assert.deepEqual(p.days.map(d => [d.day, d.total]), [['2026-10-23', 444]]);
  p.files['grok-cloud'] = { collected_at: fresh, grok: { tokens_today: 100, tokens_observed_at: fresh } };
  assert.equal((await p.refresh()).result.totalTokens, 100);
  p.files['grok-cloud'] = {};
  p.files.manual = published.oldManualTokens;
  assert.equal((await p.refresh()).card('grok').tokens, null);
});

test('newer legacy manual Claude reading replaces weekly automatic quota without a five-hour mix', async () => {
  const p = await dashboard({ mac: published.weekly,
    manual: { claude: { used_percent: 40, updated_at: future } } });
  assert.equal(p.card('claude').usedPct, 40);
  assert.equal(p.card('claude').manual, true);
  assert.equal(p.card('claude').shortPct, null);
});

test('newest subscription observation wins even if it only has a short window', async () => {
  const p = await dashboard({ mac: { claude: { quota_observed_at: before,
    windows: [{ used_percent: 70, window_minutes: 10080, resets_at: future }] } },
    'grok-cloud': { claude: { quota_observed_at: fresh,
      windows: [{ used_percent: 10, window_minutes: 300, resets_at: future }] } } });
  assert.equal(p.card('claude').usedPct, 10);
  assert.equal(p.card('claude').shortPct, null);
});

test('malformed values remain unknown and status survives normalization', async () => {
  const p = await dashboard({ mac: { claude: { used_percent: '90', windows: 'invalid', tokens_by_day: {} } },
    'grok-cloud': { grok: { used_percent: 101, quota_status: 'request_failed' } } });
  assert.equal(p.card('claude').usedPct, null);
  assert.equal(p.card('grok').usedPct, null);
  assert.match(p.card('grok').reason, /额度读取失败/);
  assert.equal(p.result.totalTokens, 0);
});

test('fetch failures keep the last successful subscription snapshot', async () => {
  const p = await dashboard({ mac: { collected_at: fresh, claude: { used_percent: 30, quota_observed_at: fresh } } });
  p.files.mac = new Error('offline');
  const updated = await p.refresh();
  assert.equal(updated.card('claude').usedPct, 30);
  assert.equal(updated.result.errors[0].source, 'mac');
});

test('fresh quota and heartbeat cannot mask a stale token observation', async () => {
  const p = await dashboard({ mac: published.staleTokens, 'grok-cloud': { collected_at: fresh } });
  assert.equal(p.card('claude').stale, 'warning');
  assert.equal(p.card('claude').readingAt, '2026-10-23T12:00:00.000Z');
  assert.equal(p.card('claude').staleAt, '2026-10-23T11:00:00.000Z');
  assert.equal(p.header.staleLevel, 'warning');
});

test('Beijing midnight expires today tokens even when the browser is in another timezone', async () => {
  const p = await dashboard({ mac: { collected_at: '2026-10-23T15:59:00Z',
    grok: { tokens_today: 100, tokens_observed_at: '2026-10-23T15:59:00Z' } } },
  Date.parse('2026-10-23T16:01:00Z'));
  assert.equal(p.card('grok').tokens, null);
});

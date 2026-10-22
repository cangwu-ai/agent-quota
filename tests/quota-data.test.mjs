import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createQuotaLoader, startQuotaRefresh, loadQuota } from '../frontend/quota-data.mjs';
const now = Date.parse('2026-10-20T12:00:00Z');
const fixtures = Object.fromEntries(await Promise.all(['mac', 'grok-cloud', 'manual'].map(async key => [key, JSON.parse(await readFile(new URL(`./fixtures/quota/${key}.json`, import.meta.url)))])));
function setup() {
  const files = structuredClone(fixtures), calls = [];
  let time = now;
  const loader = createQuotaLoader({ now: () => time, fetch: async (url, options) => {
    calls.push({ url, options });
    const key = new URL(url).pathname.split('/').at(-1).replace('.json', '');
    if (files[key] instanceof Error) throw files[key];
    return { ok: !!files[key], status: files[key] ? 200 : 404, json: async () => files[key] };
  } });
  return { files, calls, loader, advance: minutes => { time = now + minutes * 60000; } };
}
test('exports default loadQuota; sums today once per provider/source, preserves unknown', async () => {
  assert.equal(typeof loadQuota, 'function');
  const { loader } = setup();
  const result = await loader();
  assert.equal(result.totalTokens, 380);
  assert.equal(result.pools.length, 6);
  assert.equal(result.pools.find(p => p.provider === 'antigravity').tokens, null);
  assert.equal(new Set(result.pools.map(p => p.id)).size, 6);
  assert.equal(result.updatedAt, '2026-10-20T12:00:00.000Z');
});
test('strict 30/60 minute thresholds and unknown timestamps', async () => {
  const s = setup();
  s.files.manual.pools.pop();
  for (const [age, expected] of [[0,'fresh'],[30,'fresh'],[30.01,'warning'],[60,'warning'],[60.01,'critical']]) {
    s.advance(age); assert.equal((await s.loader()).staleLevel, expected);
  }
  s.files.mac.pools[0].updated_at = null;
  s.advance(0); assert.equal((await s.loader()).staleLevel, 'critical');
});
test('old source observation stays stale despite fresh heartbeat', async () => {
  const s = setup(); s.files.mac.pools[0].updated_at = '2026-10-20T10:00:00Z';
  assert.equal((await s.loader()).staleLevel, 'critical');
});
test('one missing source still returns available totals and an actionable error', async () => {
  const s = setup(); delete s.files['grok-cloud'];
  const result = await s.loader();
  assert.equal(result.totalTokens, 330);
  assert.equal(result.errors[0].source, 'grok-cloud');
  assert.match(result.errors[0].message, /404/);
  assert.equal(result.staleLevel, 'critical');
});
test('failure retains last successful source while others update; recovery clears errors', async () => {
  const s = setup(); await s.loader();
  s.files.mac = new Error('offline'); s.files['grok-cloud'].pools[0].tokens = 80;
  assert.equal((await s.loader()).totalTokens, 410);
  s.files.mac = structuredClone(fixtures.mac);
  assert.deepEqual((await s.loader()).errors, []);
});
test('malformed JSON object does not replace cached data', async () => {
  const s = setup(); await s.loader(); s.files.mac = [];
  const result = await s.loader(); assert.equal(result.totalTokens, 380); assert.equal(result.errors.length, 1);
});
test('uses raw branch paths, no-store, and distinct cache busters', async () => {
  const s = setup(); await s.loader(); await s.loader();
  assert.match(s.calls[0].url, /agent-quota\/data\/data\/mac.json\?/);
  assert.match(s.calls[2].url, /agent-quota\/data\/manual.json\?/);
  assert.equal(s.calls[0].options.cache, 'no-store');
  assert.notEqual(s.calls[0].url, s.calls[3].url);
});
test('legacy fields normalize without treating cloud Codex as Grok', async () => {
  const s = setup();
  s.files.mac = { collected_at: '2026-10-20T12:00:00Z', codex: { observed_at: '2026-10-20T12:00:00Z', windows: [{ used_percent: 12 }], tokens_today: 100 }, claude: { observed_at: '2026-10-20T12:00:00Z', tokens_today: 200 } };
  s.files.manual = { grok: { used_percent: 35, updated_at: '2026-10-20T12:00:00Z' } };
  const result = await s.loader(); assert.equal(result.totalTokens, 350);
  assert.equal(result.pools.find(p => p.provider === 'grok').used_pct, 35);
});
test('all missing returns empty pools, zero known tokens and critical status', async () => {
  const s = setup(); for (const key of Object.keys(s.files)) delete s.files[key];
  const result = await s.loader(); assert.deepEqual(result.pools, []); assert.equal(result.totalTokens, 0); assert.equal(result.updatedAt, null); assert.equal(result.errors.length, 3);
});
test('refresh loads immediately, every five minutes, on foreground only, and cleans up', async () => {
  const doc = new EventTarget(); doc.visibilityState = 'visible';
  let tick, interval, cleared, count = 0; const results = [];
  const stop = startQuotaRefresh(result => results.push(result), { load: async () => ++count, document: doc, setInterval: (fn, ms) => { tick = fn; interval = ms; return 42; }, clearInterval: id => { cleared = id; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(interval, 300000); assert.deepEqual(results, [1]);
  await tick(); doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(count, 2);
  doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange'));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(count, 3);
  stop(); assert.equal(cleared, 42); doc.dispatchEvent(new Event('visibilitychange')); assert.equal(count, 3);
});
test('manual root 404 falls back to legacy path', async () => {
  const urls = [];
  const loader = createQuotaLoader({ now: () => now, fetch: async url => {
    urls.push(url);
    if (new URL(url).pathname.endsWith('/data/manual.json') && !new URL(url).pathname.endsWith('/data/data/manual.json')) return { ok: false, status: 404 };
    return { ok: true, json: async () => fixtures[url.includes('manual.json') ? 'manual' : url.includes('mac.json') ? 'mac' : 'grok-cloud'] };
  } });
  assert.equal((await loader()).totalTokens, 380);
  assert.equal(urls.length, 4);
  assert.match(urls[3], /\/data\/data\/manual.json/);
});
test('concurrent loads coalesce; failed refresh recomputes age rather than refreshing timestamps', async () => {
  const s = setup(); const [a,b] = await Promise.all([s.loader(), s.loader()]);
  assert.deepEqual(a,b); assert.equal(s.calls.length, 3);
  for (const key of Object.keys(s.files)) s.files[key] = new Error('offline');
  s.advance(61); const result = await s.loader();
  assert.equal(result.totalTokens, 380); assert.equal(result.staleLevel, 'critical');
  assert.equal(result.updatedAt, a.updatedAt); assert.equal(result.errors.length, 3);
});
test('invalid tokens never poison total and missing dates are critical', async () => {
  const s = setup();
  s.files.mac.pools[0].tokens = -1; s.files.mac.pools[1].tokens = '100';
  s.files.mac.pools[2].tokens = Infinity; s.files['grok-cloud'].pools[0].tokens_period = 'week';
  const result = await s.loader(); assert.equal(result.totalTokens, 30); assert.equal(result.staleLevel, 'critical');
});
test('JSON parse errors retain last successful data', async () => {
  let broken = false;
  const loader = createQuotaLoader({ now: () => now, fetch: async url => ({ ok: true, json: async () => {
    if (broken) throw new SyntaxError('bad JSON');
    return fixtures[url.includes('manual.json') ? 'manual' : url.includes('mac.json') ? 'mac' : 'grok-cloud'];
  } }) });
  await loader(); broken = true;
  const result = await loader(); assert.equal(result.totalTokens, 380); assert.equal(result.errors.length, 3);
});
test('unknown file heartbeat cannot be replaced by fresh pool observations', async () => {
  const s = setup(); s.files.manual.pools.pop();
  s.files.mac.updated_at = 'invalid';
  const result = await s.loader();
  assert.equal(result.updatedAt, null); assert.equal(result.staleLevel, 'critical');
});

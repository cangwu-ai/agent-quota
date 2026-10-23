const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('index.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const now = new Date().toISOString();
const before = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const past = new Date(Date.now() - 2 * 86400000).toISOString();
const future = new Date(Date.now() + 86400000).toISOString();
const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);

function page(data = {}) {
  const elements = new Map();
  const element = () => ({ innerHTML: '', textContent: '', style: {}, setAttribute() {}, getAttribute() {},
    addEventListener() {}, querySelectorAll() { return []; } });
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    addEventListener() {}, documentElement: {} };
  const context = vm.createContext({ document, navigator: {}, setInterval() {}, console,
    fetch: async () => ({ ok: false }), Date });
  vm.runInContext(script, context);
  vm.runInContext(`data = ${JSON.stringify({ mac: null, 'grok-cloud': null, manual: null, ...data })}`, context);
  return { run: expr => vm.runInContext(expr, context), elements };
}

test('Claude automatic weekly quota and five-hour value display; zero is available', () => {
  const p = page({ mac: { claude: { quota_observed_at: now, windows: [
    { used_percent: 0, window_minutes: 10080, resets_at: future },
    { used_percent: 20, window_minutes: 300, resets_at: future }] } } });
  assert.equal(p.run('poolReading(POOLS[1]).pct'), 0);
  assert.equal(p.run('poolReading(POOLS[1]).extra[1]'), '20%');
  p.run('renderGauges()');
  assert.match(p.elements.get('gauges').innerHTML, /自动采集/);
});

test('Grok uses the newest account observation, with newer manual fallback', () => {
  const p = page({ mac: { grok: { used_percent: 10, quota_observed_at: before } },
    'grok-cloud': { grok: { used_percent: 25, quota_observed_at: now } },
    manual: { grok: { used_percent: 90, updated_at: past } } });
  assert.equal(p.run('poolReading(POOLS[2]).pct'), 25);
  p.run(`data.manual.grok = {used_percent: 0, updated_at: ${JSON.stringify(future)}}`);
  assert.equal(p.run('poolReading(POOLS[2]).pct'), 0);
  assert.equal(p.run('poolReading(POOLS[2]).auto'), false);
});

test('Grok tokens appear on the gauge and in totals', () => {
  const p = page({ 'grok-cloud': { collected_at: now, grok: { tokens_today: 1234,
    tokens_by_day: [{ day, tokens: 1234 }], tokens_observed_at: now, quota_status: 'auth_required' } } });
  p.run('render()');
  assert.match(p.elements.get('gauges').innerHTML, /1234/);
  assert.match(p.elements.get('legend').innerHTML, /Grok/);
  assert.match(p.elements.get('total-today').innerHTML, /1234/);
  assert.match(p.elements.get('gauges').innerHTML, /登录/);
});

test('Claude logs remain visible when the percentage is unknown', () => {
  const p = page({ mac: { collected_at: now, claude: { tokens_today: 321, observed_at: now } } });
  p.run('render()');
  assert.match(p.elements.get('gauges').innerHTML, /321/);
  assert.match(p.elements.get('gauges').innerHTML, /仅有 token/);
  assert.doesNotMatch(p.elements.get('gauges').innerHTML, /未填写/);
});

test('stale percentages are labelled, expired periods are not current quota', () => {
  const p = page({ mac: { claude: { used_percent: 20, quota_observed_at: before, resets_at: future } },
    'grok-cloud': { grok: { used_percent: 75, quota_observed_at: past, resets_at: past } } });
  p.run('renderGauges()');
  assert.match(p.elements.get('gauges').innerHTML, /数据过期/);
  assert.equal(p.run('poolReading(POOLS[2]).pct'), null);
  assert.match(p.elements.get('gauges').innerHTML, /周期已结束/);
});

test('yesterday tokens are not relabelled today by a newer quota response', () => {
  const p = page({ mac: { collected_at: past, claude: { tokens_today: 999, observed_at: now,
    tokens_by_day: [{ day: past.slice(0, 10), tokens: 999 }] } } });
  assert.equal(p.run('tokensOf("claude").today'), null);
  p.run('renderTotals()');
  assert.equal(p.elements.get('total-today').innerHTML, '—');
});

test('history older than seven Beijing calendar days is excluded', () => {
  const at = new Date(Date.now() - 20 * 86400000).toISOString();
  const p = page({ mac: { collected_at: at, claude: { tokens_today: 999,
    tokens_by_day: [{ day: at.slice(0, 10), tokens: 999 }] } } });
  p.run('renderTotals()');
  assert.equal(p.elements.get('total-week').textContent, '近 7 天 —');
});

test('manual token input is shown only on its recorded Beijing day', () => {
  const p = page({ manual: { grok: { tokens: 444, used_percent: 20, updated_at: now } } });
  assert.equal(p.run('tokensOf("grok").today'), 444);
  p.run(`data.manual.grok.updated_at = ${JSON.stringify(past)}`);
  assert.equal(p.run('tokensOf("grok")'), null);
});

test('missing data stays unknown and malformed values do not break the page', () => {
  const p = page({ mac: { claude: { used_percent: '90', windows: 'invalid', tokens_by_day: {} } },
    'grok-cloud': { grok: { used_percent: 101, quota_status: 'request_failed' } } });
  p.run('render()');
  assert.equal(p.run('poolReading(POOLS[1]).pct'), null);
  assert.equal(p.run('poolReading(POOLS[2]).pct'), null);
  assert.match(p.elements.get('gauges').innerHTML, /额度读取失败/);
  assert.equal(p.elements.get('total-today').innerHTML, '—');
  assert.equal(p.elements.get('total-week').textContent, '近 7 天 —');
});

test('fetch failures keep the last successful snapshots', async () => {
  const p = page({ mac: { collected_at: now, claude: { used_percent: 30, observed_at: now } } });
  await p.run('load()');
  assert.equal(p.run('poolReading(POOLS[1]).pct'), 30);
});

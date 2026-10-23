import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as data from '../frontend/quota-data.mjs';
import * as model from '../frontend/dashboard-model.mjs';

const html = readFileSync('index.html', 'utf8');
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const published = JSON.parse(readFileSync('tests/fixtures/quota/subscriptions.json', 'utf8'));
const now = Date.parse('2026-10-23T12:00:00Z');

async function page(file) {
  const load = data.createQuotaLoader({ now: () => now, fetch: async url => ({ ok: true,
    json: async () => url.includes('grok-cloud.json') ? file : {} }) });
  const result = await load();
  const cards = model.buildCards(result.pools, now);
  const elements = new Map(), fields = new Map();
  const element = () => ({ dataset: {}, style: {}, hidden: false, innerHTML: '', textContent: '',
    className: '', querySelectorAll: () => [] });
  const get = (map, key) => { if (!map.has(key)) map.set(key, element()); return map.get(key); };
  const warnings = [];
  const context = vm.createContext({ ...data, ...model, Date,
    document: { getElementById: id => get(elements, id) },
    console: { warn: (...args) => warnings.push(args) },
    cardEl: { querySelector: selector => get(fields, selector.match(/data-f="([^"]+)"/)[1]) },
    card: cards.find(c => c.provider === 'grok'), result, cards, now });
  // Execute the real page's render functions with DOM fields as the only test double.
  const constants = script.slice(script.indexOf('const $ ='), script.indexOf('// 本地验证'));
  const renderers = script.slice(script.indexOf('/** Compact number button'), script.indexOf('/* ---------- 顶栏状态'));
  vm.runInContext(constants + "\nlet mode = 'used';\n" + renderers, context);
  vm.runInContext('updateCard(cardEl, card, now, false); renderTotals(result, cards);', context);
  return { fields, elements, warnings };
}

test('page displays login recovery status alongside published Grok tokens and totals', async () => {
  const p = await page(published.grokLogin);
  assert.equal(p.fields.get('pct').textContent, '—');
  assert.match(p.fields.get('pct-label').textContent, /登录/);
  assert.match(p.fields.get('chips').innerHTML, /登录/);
  assert.match(p.fields.get('tok').innerHTML, /1,234 token/);
  assert.match(p.elements.get('total').innerHTML, /1,234 token/);
  assert.match(p.elements.get('legend').innerHTML, /Grok/);
  assert.match(p.elements.get('bars').innerHTML, /1,234/);
  assert.deepEqual(p.warnings, []);
});

test('page keeps missing usage unknown instead of displaying a fabricated zero', async () => {
  const p = await page({});
  assert.equal(p.fields.get('pct').textContent, '—');
  assert.match(p.fields.get('tok').innerHTML, /无用量记录/);
  assert.equal(p.elements.get('total').innerHTML, '—');
  assert.match(p.elements.get('bars').innerHTML, /暂无逐日记录/);
});

/** Pure view model for the ring dashboard: no DOM, no timers, testable in Node. */

/** Known pools in display order. Unknown providers from the pools protocol are appended. */
export const PROVIDERS = [
  { provider: 'codex', name: 'ChatGPT', members: 'Pro · Codex · Dots', logo: 'assets/logos/codex-dark.svg', series: 'Codex' },
  { provider: 'claude', name: 'Claude', members: 'Max · App · Code', logo: 'assets/logos/claude-dark.svg', series: 'Claude' },
  { provider: 'grok', name: 'Grok', members: 'SuperGrok · Bot · Build', logo: 'assets/logos/grok-dark.svg', wide: true, series: 'Grok' },
  { provider: 'antigravity', name: 'Antigravity', members: 'Google AI', logo: 'assets/logos/antigravity-dark.svg', series: 'Antigravity' },
];

const MINUTE = 60000;

/** Quota status by used percentage: <60 good, 60–79 warn, ≥80 crit. */
export const quotaLevel = pct => pct == null ? 'none' : pct >= 80 ? 'crit' : pct >= 60 ? 'warn' : 'good';

/** Data age: ≤30 min fresh, ≤60 min warning, otherwise (or unknown) critical. Same thresholds as quota-data.mjs. */
export function staleOf(iso, now = Date.now()) {
  const age = iso ? now - Date.parse(iso) : NaN;
  if (!Number.isFinite(age)) return 'critical';
  return age > 60 * MINUTE ? 'critical' : age > 30 * MINUTE ? 'warning' : 'fresh';
}

/** Exact value with thousands separators. */
export const formatExact = n => n == null ? '—' : Math.round(n).toLocaleString('en-US');

/** Compact value: < 100,000 keeps thousands separators, larger numbers use K/M/B. Returns [value, unit]. */
export function formatCompact(n) {
  if (n == null) return ['—', ''];
  if (Math.abs(n) < 1e5) return [formatExact(n), ''];
  for (const [unit, size] of [['K', 1e3], ['M', 1e6], ['B', 1e9]]) {
    const v = n / size;
    const digits = Math.abs(v) < 10 ? 2 : Math.abs(v) < 100 ? 1 : 0;
    const rounded = Number(v.toFixed(digits));
    // Round before choosing the unit so 999,960 becomes 1.00M rather than 1,000K.
    if (Math.abs(rounded) < 1000 || unit === 'B') {
      return [rounded.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }), unit];
    }
  }
}
export const formatCompactText = n => formatCompact(n).join('');

/** "刚刚 / N 分钟前 / N 小时前 / N 天前". */
export function relativeTime(iso, now = Date.now()) {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '无数据';
  const m = Math.round((now - t) / MINUTE);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  if (m < 48 * 60) return `${Math.round(m / 60)} 小时前`;
  return `${Math.round(m / 1440)} 天前`;
}

/** Local "MM-DD HH:mm". */
export function absoluteTime(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '—';
  const p = v => String(v).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Countdown to a reset time: "3 天 14 时" / "5 时 20 分" / "已重置". */
export function untilTime(iso, now = Date.now()) {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const ms = t - now;
  if (ms <= 0) return '已重置';
  const h = Math.floor(ms / 3600000);
  return h >= 24 ? `${Math.floor(h / 24)} 天 ${h % 24} 时` : `${h} 时 ${Math.floor((ms % 3600000) / MINUTE)} 分`;
}

const RANK = { fresh: 0, warning: 1, critical: 2 };
/** Worst of several stale levels (nulls ignored); 'fresh' when there is nothing to judge. */
export const worstStale = levels => levels.filter(Boolean).reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'fresh');
/** Oldest timestamp; any unknown time (null/invalid) wins so it is flagged rather than hidden. */
function oldestTime(times) {
  if (!times.length || times.some(t => !Number.isFinite(Date.parse(t)))) return null;
  return times.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
}

/** Same de-duplication key as quota-data.mjs totalTokens, so card sums equal the total. */
const tokenKey = pool => pool.tokens_scope === 'provider-source' ? `${pool.source}:${pool.provider}` : pool.id;

const isManual = pool => pool.source === 'manual' || pool.manual === true;
/** Window from the field, or from the id suffix of the pools protocol ("codex:5h"). */
const windowOf = pool => pool.window ?? pool.id?.split(':').at(-1);
const isShortWindow = pool => windowOf(pool) === '5h' || (pool.window_minutes != null && pool.window_minutes <= 300);
const windowLabel = pool => isManual(pool) ? '本周期' : (windowOf(pool) === 'weekly' || pool.window_minutes === 10080) ? '本周' : '本周期';

/** Latest reading wins (auto sources before manual); within one snapshot the most-used bucket wins. */
function pickReading(readings) {
  if (!readings.length) return null;
  const auto = readings.filter(p => !isManual(p));
  const pool = auto.length ? auto : readings;
  const time = p => Date.parse(p.updated_at) || 0;
  const latest = Math.max(...pool.map(time));
  return pool.filter(p => time(p) === latest).reduce((a, b) => (b.used_pct > a.used_pct ? b : a));
}

/** Group pools into one card per provider. */
export function buildCards(pools, now = Date.now()) {
  const known = new Map(PROVIDERS.map(p => [p.provider, p]));
  const order = [...PROVIDERS.map(p => p.provider)];
  for (const pool of pools) if (!order.includes(pool.provider)) order.push(pool.provider);

  return order.map(provider => {
    const meta = known.get(provider) ?? { provider, name: pools.find(p => p.provider === provider)?.name ?? provider, members: '', logo: null, series: provider };
    const rows = pools.filter(p => p.provider === provider);

    const seen = new Set();
    let tokens = null;
    const byDay = new Map();
    const tokenTimes = [];
    for (const pool of rows) {
      if (pool.tokens == null) continue;
      const key = tokenKey(pool);
      if (seen.has(key)) continue;
      seen.add(key);
      tokens = (tokens ?? 0) + pool.tokens;
      tokenTimes.push(pool.updated_at ?? null);
      for (const d of pool.tokens_by_day ?? []) {
        if (typeof d?.day === 'string' && Number.isFinite(d.tokens)) byDay.set(d.day, (byDay.get(d.day) ?? 0) + d.tokens);
      }
    }

    const readings = rows.filter(p => p.used_pct != null);
    const main = pickReading(readings.filter(p => !isShortWindow(p))) ?? pickReading(readings);
    const short = main && !isShortWindow(main) ? pickReading(readings.filter(isShortWindow)) : null;
    // Every observation shown on the card (ring, 5h figure, tokens) counts; the oldest one sets its age.
    const shown = [...(main ? [main.updated_at ?? null] : []), ...(short ? [short.updated_at ?? null] : []), ...tokenTimes];
    const staleAt = oldestTime(shown);

    return {
      ...meta,
      tokens,
      byDay,
      usedPct: main?.used_pct ?? null,
      remainingPct: main ? 100 - main.used_pct : null,
      level: quotaLevel(main?.used_pct ?? null),
      windowLabel: main ? windowLabel(main) : '本周期',
      resetsAt: main?.resets_at ?? null,
      readingAt: main?.updated_at ?? null,
      manual: !!main && isManual(main),
      shortPct: short?.used_pct ?? null,
      staleAt,
      stale: shown.length ? staleOf(staleAt, now) : null,
    };
  });
}

/** Last `count` days that appear in any card's history, oldest first, with per-card values. */
export function buildDays(cards, count = 7) {
  const days = [...new Set(cards.flatMap(c => [...c.byDay.keys()]))].sort().slice(-count);
  return days.map(day => ({ day, parts: cards.map(c => c.byDay.get(day) ?? 0), total: cards.reduce((a, c) => a + (c.byDay.get(day) ?? 0), 0) }));
}

/** Sum of per-card tokens (null-safe). Equal to loadQuota().totalTokens by construction. */
export const sumCardTokens = cards => cards.reduce((a, c) => a + (c.tokens ?? 0), 0);

/** Automatic collectors, shown as heartbeats in the header. manual.json has no heartbeat of its own. */
export const AUTO_SOURCES = [{ source: 'mac', label: 'Mac' }, { source: 'grok-cloud', label: '云电脑' }];

/**
 * Header status. `updatedAt` is the newest automatic heartbeat (last collection), shown as "上次更新".
 * `staleLevel` is the worst of every loaded automatic source and every observation still displayed on
 * a card (manual readings and token-only pools included), so a healthy collector never masks one that
 * stopped. `staleItems` lists what is out of date, for the banner.
 */
export function headerStatus(result, now = Date.now(), cards = buildCards(result?.pools ?? [], now)) {
  const sources = AUTO_SOURCES.map(({ source, label }) => {
    const s = result?.sources?.find(x => x.source === source);
    const updatedAt = s?.loaded ? s.updatedAt : null;
    return { source, label, loaded: !!s?.loaded, failed: !!s?.failed, updatedAt, staleLevel: staleOf(updatedAt, now) };
  });
  const times = sources.map(s => s.updatedAt).filter(Boolean);
  const updatedAt = times.length ? times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)) : null;
  const staleItems = [
    ...sources.filter(s => s.loaded && s.staleLevel !== 'fresh').map(s => ({ kind: 'source', label: s.label, at: s.updatedAt, level: s.staleLevel })),
    ...cards.filter(c => c.stale && c.stale !== 'fresh').map(c => ({ kind: 'card', label: c.name, at: c.staleAt, level: c.stale, manual: c.manual })),
  ];
  // No automatic heartbeat at all is critical too: nothing proves any number is current.
  const staleLevel = updatedAt ? worstStale(staleItems.map(i => i.level)) : 'critical';
  return { updatedAt, staleLevel, staleItems, sources, hasData: (result?.pools?.length ?? 0) > 0 };
}

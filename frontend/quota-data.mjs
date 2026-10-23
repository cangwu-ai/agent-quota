/** Pure browser data layer. No requests or timers are started on import. */
const RAW = 'https://raw.githubusercontent.com/cangwu-ai/agent-quota/data/';
const SOURCES = [['mac', 'data/mac.json'], ['grok-cloud', 'data/grok-cloud.json'], ['manual', 'manual.json']];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const oldest = values => values.length && values.every(Boolean) ? values.reduce((a, b) => a < b ? a : b) : null;
function stale(at, now) {
  const age = at ? now - Date.parse(at) : Infinity;
  return age > 60 * 60000 ? 'critical' : age > 30 * 60000 ? 'warning' : 'fresh';
}

function legacyPools(file, source) {
  const rows = [];
  for (const provider of ['codex', 'claude', 'grok', 'antigravity']) {
    const value = file[source === 'manual' && provider === 'codex' ? 'chatgpt' : provider];
    if (!object(value)) continue;
    const windows = value.windows ?? value.buckets;
    const readings = Array.isArray(windows) && windows.length ? windows : [value];
    readings.forEach((reading, i) => rows.push({
      id: `${provider}:${reading.group ?? ''}:${reading.window ?? reading.window_minutes ?? i}`,
      provider, name: provider, used_pct: reading.used_percent,
      window: reading.window ?? null, window_minutes: reading.window_minutes ?? null,
      tokens: value.tokens_today ?? value.tokens,
      tokens_by_day: Array.isArray(value.tokens_by_day) ? value.tokens_by_day : undefined,
      tokens_period: 'today', tokens_scope: 'provider-source',
      updated_at: value.quota_observed_at ?? value.observed_at ?? value.updated_at,
      resets_at: reading.resets_at ?? (value.resets_on ? `${value.resets_on}T00:00:00+08:00` : null),
    }));
  }
  return rows;
}

function normalize(file, source, now) {
  const rows = file.pools ?? legacyPools(file, source);
  if (!Array.isArray(rows) || rows.some(row => !object(row) || typeof row.id !== 'string' || typeof row.provider !== 'string')) {
    throw new Error('Invalid pools schema');
  }
  return rows.map(row => {
    // PR#2 publishes pools plus compatibility nodes. Keep the latter's independent
    // quota/token observations, history and login status when using the pools API.
    const legacy = file[source === 'manual' && row.provider === 'codex' ? 'chatgpt' : row.provider] ?? {};
    const used = number(row.used_pct);
    const updatedAt = timestamp(row.quota_observed_at ?? legacy.quota_observed_at ?? row.updated_at);
    const tokensAt = timestamp(row.tokens_observed_at ?? legacy.tokens_observed_at ?? legacy.observed_at ?? row.updated_at);
    const tokenDate = source === 'manual' ? tokensAt
      : row.tokens_observed_at ?? legacy.tokens_observed_at ?? file.collected_at ?? file.updated_at ?? tokensAt;
    const history = row.tokens_by_day ?? legacy.tokens_by_day;
    const firstDay = beijingDay(now - 6 * 86400000), today = beijingDay(now);
    const byDay = Array.isArray(history) ? history.filter(d => object(d)
      && typeof d.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.day)
      && d.day >= firstDay && d.day <= today && number(d.tokens) !== null) : [];
    let tokens = row.tokens_period === 'today' && beijingDay(tokenDate) === today ? number(row.tokens) : null;
    if (tokens === null) tokens = number(byDay.find(d => d.day === today)?.tokens);
    if (source === 'manual' && tokens !== null && !byDay.some(d => d.day === today)) byDay.push({ day: today, tokens });
    const suffix = row.id.split(':').at(-1);
    const windowMinutes = row.window_minutes ?? (/^\d+$/.test(suffix) && Number(suffix) > 0 ? Number(suffix) : null);
    return { ...row, id: `${source}:${row.id}`, source,
      used_pct: used === null || used > 100 ? null : used,
      remaining_pct: used === null || used > 100 ? null : 100 - used,
      window_minutes: windowMinutes,
      resets_at: row.resets_at ?? legacy.resets_at ?? (legacy.resets_on ? `${legacy.resets_on}T00:00:00+08:00` : null),
      quota_status: row.quota_status ?? legacy.quota_status,
      // A failed check has no successful quota observation. Its file heartbeat
      // dates the diagnosis without making an old percentage look fresh.
      quota_checked_at: timestamp(row.quota_checked_at ?? legacy.quota_checked_at ?? file.collected_at ?? file.updated_at ?? row.updated_at),
      tokens, tokens_by_day: byDay, tokens_observed_at: tokensAt,
      updated_at: updatedAt, staleLevel: stale(updatedAt, now),
    };
  });
}

/** Token collection uses Beijing calendar days, regardless of the browser timezone. */
export function beijingDay(at) {
  const time = at == null ? NaN : new Date(at).getTime();
  return Number.isFinite(time) ? new Date(time + 8 * 3600000).toISOString().slice(0, 10) : null;
}

/** Isolated per-consumer cache; concurrent loads share one request batch. */
export function createQuotaLoader({ fetch: fetcher = globalThis.fetch, now = Date.now, baseUrl = RAW, timeoutMs = 15000 } = {}) {
  const cache = new Map();
  let pending, sequence = 0;
  async function request(path, bust) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(`${baseUrl}${path}?t=${bust}`, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`); error.status = response.status; throw error;
      }
      const file = await response.json();
      if (!object(file)) throw new Error('Invalid quota JSON object');
      return file;
    } finally { clearTimeout(timer); }
  }
  async function load() {
    const bust = `${now()}-${++sequence}`;
    const errors = [];
    await Promise.all(SOURCES.map(async ([source, path]) => {
      try {
        let file;
        try { file = await request(path, bust); }
        catch (error) {
          if (source !== 'manual' || error.status !== 404) throw error;
          file = await request('data/manual.json', bust);
        }
        normalize(file, source, now()); // Validate before replacing last good source.
        cache.set(source, file);
      } catch (error) {
        errors.push({ source, message: `${source} 拉取失败，${cache.has(source) ? '保留上次数据' : '暂无数据'}：${error.message}` });
      }
    }));
    const time = now();
    const pools = SOURCES.flatMap(([source]) => cache.has(source) ? normalize(cache.get(source), source, time) : []);
    // Manual tokens are a fallback for providers without an automatic daily log.
    const automaticTokens = new Set(pools.filter(p => p.source !== 'manual' && p.tokens !== null).map(p => p.provider));
    for (const pool of pools) if (pool.source === 'manual' && automaticTokens.has(pool.provider)) {
      pool.tokens = null;
      pool.tokens_by_day = [];
    }
    const seen = new Set();
    let totalTokens = 0;
    for (const pool of pools) {
      if (pool.tokens === null) continue;
      const key = pool.tokens_scope === 'provider-source' ? `${pool.source}:${pool.provider}` : pool.id;
      if (!seen.has(key)) { totalTokens += pool.tokens; seen.add(key); }
    }
    const times = SOURCES.map(([source]) => {
      const file = cache.get(source);
      if (!file) return null;
      // Legacy manual documents have no heartbeat; use their oldest observation.
      if (source === 'manual' && !('pools' in file) && !('updated_at' in file)) {
        return oldest(pools.filter(p => p.source === source).map(p => p.updated_at));
      }
      return timestamp('updated_at' in file ? file.updated_at : file.collected_at);
    });
    const updatedAt = oldest(times);
    const levels = [stale(updatedAt, time), ...pools.map(p => p.staleLevel)];
    const staleLevel = levels.includes('critical') ? 'critical' : levels.includes('warning') ? 'warning' : 'fresh';
    const sources = SOURCES.map(([source], i) => ({
      source, loaded: cache.has(source), updatedAt: times[i], staleLevel: stale(times[i], time),
      failed: errors.some(e => e.source === source),
    }));
    return { pools, totalTokens, updatedAt, staleLevel, errors, sources };
  }
  return function loadQuota() {
    if (!pending) pending = load().finally(() => { pending = null; });
    return pending;
  };
}

export const loadQuota = createQuotaLoader();

/** Start immediate/5-minute/foreground refresh. Returns an idempotent disposer. */
export function startQuotaRefresh(onUpdate, {
  load = loadQuota, document: doc = globalThis.document,
  setInterval: schedule = globalThis.setInterval, clearInterval: cancel = globalThis.clearInterval,
  onError = error => console.error('Quota refresh failed', error),
} = {}) {
  let stopped = false, pending;
  function refresh() {
    if (stopped) return Promise.resolve();
    if (!pending) pending = Promise.resolve().then(load).then(result => {
      if (!stopped) onUpdate(result);
    }).catch(error => { if (!stopped) onError(error); }).finally(() => { pending = null; });
    return pending;
  }
  const visible = () => { if (doc.visibilityState === 'visible') void refresh(); };
  doc?.addEventListener('visibilitychange', visible);
  const timer = schedule(refresh, 5 * 60 * 1000);
  void refresh();
  return () => {
    if (stopped) return;
    stopped = true; cancel(timer); doc?.removeEventListener('visibilitychange', visible);
  };
}

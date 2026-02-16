const activeTripCache = new Map();

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const parsedTtl = Number(process.env.ACTIVE_TRIP_CACHE_TTL_MS);
const ACTIVE_TRIP_CACHE_TTL_MS = Number.isFinite(parsedTtl) && parsedTtl > 0 ? parsedTtl : DEFAULT_TTL_MS;

function normalizeTripId(value) {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

export function setActiveTripCache(chatId, { tripId = null, tripName = null, baseCurrency = null, ts = Date.now() } = {}) {
  activeTripCache.set(String(chatId), {
    tripId: normalizeTripId(tripId),
    tripName: tripName == null ? null : String(tripName),
    baseCurrency: baseCurrency == null ? null : String(baseCurrency).toUpperCase(),
    ts: Number(ts) || Date.now()
  });
}

export function getActiveTripCache(chatId, { now = Date.now(), ttlMs = ACTIVE_TRIP_CACHE_TTL_MS } = {}) {
  const key = String(chatId);
  const entry = activeTripCache.get(key);
  if (!entry) return null;

  if (now - entry.ts > ttlMs) {
    activeTripCache.delete(key);
    return null;
  }

  return { ...entry };
}

export function getActiveTripCacheTtlMs() {
  return ACTIVE_TRIP_CACHE_TTL_MS;
}

export function __resetActiveTripCache() {
  activeTripCache.clear();
}

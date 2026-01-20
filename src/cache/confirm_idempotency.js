const CACHE_TTL_MS = Number(process.env.CONFIRM_IDEMPOTENCY_TTL_MS || 10 * 60 * 1000);
const idempotencyCache = new Map();

function isExpired(entry) {
  return !entry || Date.now() > entry.expiresAt;
}

export function getIdempotencyEntry(key) {
  const entry = idempotencyCache.get(key);
  if (isExpired(entry)) {
    idempotencyCache.delete(key);
    return null;
  }
  return entry;
}

export function setIdempotencyPending(key) {
  idempotencyCache.set(key, {
    status: "pending",
    expenseId: null,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
}

export function setIdempotencySaved(key, expenseId) {
  idempotencyCache.set(key, {
    status: "saved",
    expenseId: expenseId ? String(expenseId) : null,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
}

export function clearIdempotencyEntry(key) {
  idempotencyCache.delete(key);
}

export function __resetConfirmIdempotency() {
  idempotencyCache.clear();
}

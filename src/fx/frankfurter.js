import { FX_BASE_URL } from "../config.js";

const FX_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FX_CACHE_MAX_KEYS = 500;

function parseIsoDateUTC(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid FX date format: ${value}. Expected YYYY-MM-DD.`);
  }

  const [yearStr, monthStr, dayStr] = value.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const dt = new Date(Date.UTC(year, month - 1, day));

  if (
    Number.isNaN(dt.getTime()) ||
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() + 1 !== month ||
    dt.getUTCDate() !== day
  ) {
    throw new Error(`Invalid FX date value: ${value}.`);
  }

  return dt;
}

function toIsoDateUTC(dateObj) {
  return dateObj.toISOString().slice(0, 10);
}

function normalizeCurrency(code, label) {
  if (typeof code !== "string") {
    throw new Error(`Invalid ${label} currency: ${code}.`);
  }

  const normalized = code.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new Error(`Invalid ${label} currency: ${code}. Expected ISO-4217 like MXN.`);
  }

  return normalized;
}

function buildUrl({ baseUrl, date, base, quote }) {
  const root = String(baseUrl || "https://api.frankfurter.dev/v1").replace(/\/+$/, "");
  const params = new URLSearchParams({ base, symbols: quote });
  return `${root}/${date}?${params.toString()}`;
}

export function createFrankfurterClient({
  fetchFn = globalThis.fetch,
  baseUrl = FX_BASE_URL,
  nowFn = () => Date.now(),
  logError = (event) => console.error(JSON.stringify(event))
} = {}) {
  if (typeof fetchFn !== "function") {
    throw new Error("FX fetch is not available. Provide fetchFn or run in a Node version with global fetch.");
  }

  const cache = new Map();

  function readFromCache(key, now) {
    const cached = cache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= now) {
      cache.delete(key);
      return null;
    }

    cache.delete(key);
    cache.set(key, cached);
    return cached.value;
  }

  function writeToCache(key, value, now) {
    cache.set(key, {
      value,
      expiresAt: now + FX_CACHE_TTL_MS,
      createdAt: now
    });

    while (cache.size > FX_CACHE_MAX_KEYS) {
      const firstKey = cache.keys().next().value;
      if (firstKey == null) break;
      cache.delete(firstKey);
    }
  }

  async function fetchRateForDate({ date, base, quote }) {
    const url = buildUrl({ baseUrl, date, base, quote });
    let response;

    try {
      response = await fetchFn(url);
    } catch (err) {
      const msg = `FX provider request failed: ${err?.message || String(err)}`;
      logError({ type: "fx_error", provider: "frankfurter", base, quote, date, msg });
      throw new Error(msg);
    }

    if (!response?.ok) {
      const msg = `FX provider returned HTTP ${response?.status ?? "unknown"} for ${date}.`;
      logError({
        type: "fx_error",
        provider: "frankfurter",
        base,
        quote,
        date,
        msg,
        status: response?.status
      });
      throw new Error(msg);
    }

    const payload = await response.json();
    const rates = payload?.rates || {};
    const quoteRate = rates[quote];

    if (typeof quoteRate !== "number" || Number.isNaN(quoteRate)) {
      return null;
    }

    return {
      ok: true,
      date: typeof payload?.date === "string" ? payload.date : date,
      base,
      quote,
      rate: quoteRate,
      provider: "frankfurter"
    };
  }

  async function getFxRate({ date, base, quote }) {
    const baseCode = normalizeCurrency(base, "base");
    const quoteCode = normalizeCurrency(quote, "quote");
    const inputDate = parseIsoDateUTC(date);
    const inputDateISO = toIsoDateUTC(inputDate);
    const cacheKey = `${baseCode}_${quoteCode}_${inputDateISO}`;
    const now = nowFn();

    const cached = readFromCache(cacheKey, now);
    if (cached) {
      return cached;
    }

    for (let offset = 0; offset <= 7; offset += 1) {
      const candidate = new Date(inputDate.getTime() - offset * 24 * 60 * 60 * 1000);
      const candidateISO = toIsoDateUTC(candidate);
      const result = await fetchRateForDate({
        date: candidateISO,
        base: baseCode,
        quote: quoteCode
      });

      if (result) {
        writeToCache(cacheKey, result, now);
        return result;
      }
    }

    const msg = `FX provider did not return rate for ${quoteCode} using ${baseCode} from ${inputDateISO} to 7 days back.`;
    logError({
      type: "fx_error",
      provider: "frankfurter",
      base: baseCode,
      quote: quoteCode,
      date: inputDateISO,
      msg
    });
    throw new Error(msg);
  }

  return {
    getFxRate,
    __resetCache: () => cache.clear(),
    __cacheSize: () => cache.size
  };
}

const defaultClient = createFrankfurterClient();

export async function getFxRate(input) {
  return defaultClient.getFxRate(input);
}

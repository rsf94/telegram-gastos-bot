export const FX_RATE_DIRECTION_QUOTE_PER_BASE = "quote_per_base";

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function normalizeCurrency(code, fallback = "MXN") {
  const value = String(code || fallback).trim().toUpperCase();
  return /^[A-Z]{3}$/.test(value) ? value : fallback;
}

export function convertAmountToBaseCurrency({
  amount,
  amountCurrency,
  baseCurrency,
  quoteCurrency,
  fxRate,
  fxRateDirection = FX_RATE_DIRECTION_QUOTE_PER_BASE
}) {
  const numericAmount = toFiniteNumber(amount);
  const rate = toFiniteNumber(fxRate);
  if (numericAmount == null || numericAmount <= 0 || rate == null || rate <= 0) return null;

  const normalizedAmountCurrency = normalizeCurrency(amountCurrency, quoteCurrency || baseCurrency);
  const normalizedBase = normalizeCurrency(baseCurrency);
  const normalizedQuote = normalizeCurrency(quoteCurrency || normalizedAmountCurrency);

  if (fxRateDirection !== FX_RATE_DIRECTION_QUOTE_PER_BASE) return null;

  if (normalizedAmountCurrency === normalizedBase) {
    return round2(numericAmount);
  }

  if (normalizedAmountCurrency === normalizedQuote) {
    return round2(numericAmount / rate);
  }

  return null;
}

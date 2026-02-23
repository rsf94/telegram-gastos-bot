export const JPY_PER_MXN = 9;
export const FX_PROVIDER_FIXED_TRIP = "fixed_trip";

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function normalizeCurrency(code, fallback = "MXN") {
  const value = String(code || fallback).trim().toUpperCase();
  return /^[A-Z]{3}$/.test(value) ? value : fallback;
}

export function convertJpyToMxn(jpyAmount) {
  return Number(jpyAmount) / JPY_PER_MXN;
}

export function hydrateFixedFxForDraft(draft) {
  if (!draft || typeof draft !== "object") return draft;

  const currency = normalizeCurrency(draft.currency || "MXN");
  if (currency !== "JPY") return draft;

  const amount = Number(draft.amount ?? draft.amount_mxn);
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      ...draft,
      currency: "JPY",
      base_currency: "MXN"
    };
  }

  const amountBaseCurrency = round2(convertJpyToMxn(amount));

  return {
    ...draft,
    amount,
    currency: "JPY",
    base_currency: "MXN",
    fx_required: true,
    // Rate semantics: 1 MXN = 9 JPY. Conversion used: MXN = JPY / 9.
    fx_rate: JPY_PER_MXN,
    fx_provider: FX_PROVIDER_FIXED_TRIP,
    amount_base_currency: amountBaseCurrency,
    amount_mxn: draft.is_msi ? draft.amount_mxn : amountBaseCurrency
  };
}

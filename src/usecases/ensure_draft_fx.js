import { getFxRate } from "../fx/index.js";
import {
  convertAmountToBaseCurrency,
  FX_RATE_DIRECTION_QUOTE_PER_BASE,
  normalizeCurrency
} from "../fx/contract.js";
import { hydrateFixedFxForDraft } from "./fx_fixed_jpy_mxn.js";

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function resolveOriginalAmount(draft) {
  const primary = toFiniteNumber(draft?.amount);
  if (primary != null && primary > 0) return primary;

  const fallback = toFiniteNumber(draft?.amount_mxn);
  if (fallback != null && fallback > 0) return fallback;

  return null;
}

export async function ensureDraftFx(draft, { fxClient = { getFxRate } } = {}) {
  if (!draft || typeof draft !== "object") return draft;

  const currency = normalizeCurrency(draft.currency || "MXN");
  const baseCurrency = normalizeCurrency(draft.base_currency || "MXN");
  const amount = resolveOriginalAmount(draft);

  if (!draft.trip_id && currency === "MXN" && draft.currency_explicit !== true) {
    return {
      ...draft,
      amount,
      amount_mxn: draft.is_msi ? draft.amount_mxn : (amount ?? draft.amount_mxn),
      currency: "MXN",
      base_currency: "MXN",
      amount_base_currency: amount ?? draft.amount_base_currency ?? null,
      fx_required: false,
      fx_rate: null,
      fx_provider: null,
      fx_rate_direction: null,
      fx_base_currency: null,
      fx_quote_currency: null
    };
  }

  if (amount == null) {
    return {
      ...draft,
      currency,
      base_currency: baseCurrency
    };
  }

  if (currency === baseCurrency) {
    return {
      ...draft,
      amount,
      amount_mxn: draft.is_msi ? draft.amount_mxn : amount,
      currency,
      base_currency: baseCurrency,
      amount_base_currency: amount,
      fx_required: false,
      fx_rate: null,
      fx_provider: null,
      fx_rate_direction: null,
      fx_base_currency: null,
      fx_quote_currency: null
    };
  }

  const existingAmountBase = toFiniteNumber(draft.amount_base_currency);
  const existingRate = toFiniteNumber(draft.fx_rate);
  const fxDirection = draft.fx_rate_direction || FX_RATE_DIRECTION_QUOTE_PER_BASE;
  const fxBaseCurrency = normalizeCurrency(draft.fx_base_currency || baseCurrency);
  const fxQuoteCurrency = normalizeCurrency(draft.fx_quote_currency || currency);
  if (existingAmountBase != null && existingAmountBase > 0 && existingRate != null && existingRate > 0) {
    return {
      ...draft,
      amount,
      currency,
      base_currency: baseCurrency,
      fx_required: true,
      amount_base_currency: existingAmountBase,
      fx_rate: existingRate,
      fx_provider: draft.fx_provider || null,
      fx_rate_direction: fxDirection,
      fx_base_currency: fxBaseCurrency,
      fx_quote_currency: fxQuoteCurrency
    };
  }

  try {
    const fx = await fxClient.getFxRate({
      date: draft.purchase_date,
      base: baseCurrency,
      quote: currency
    });
    const rate = Number(fx?.rate);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`Invalid FX rate for ${currency}/${baseCurrency} on ${draft.purchase_date}`);
    }

    const amountBaseCurrency = convertAmountToBaseCurrency({
      amount,
      amountCurrency: currency,
      baseCurrency,
      quoteCurrency: currency,
      fxRate: rate,
      fxRateDirection: FX_RATE_DIRECTION_QUOTE_PER_BASE
    });
    if (!Number.isFinite(amountBaseCurrency) || amountBaseCurrency <= 0) {
      throw new Error(`Could not convert ${currency} to ${baseCurrency} using rate ${rate}`);
    }

    return {
      ...draft,
      amount,
      currency,
      base_currency: baseCurrency,
      fx_required: true,
      fx_rate: rate,
      fx_provider: fx?.provider || "unknown",
      fx_rate_direction: FX_RATE_DIRECTION_QUOTE_PER_BASE,
      fx_base_currency: baseCurrency,
      fx_quote_currency: currency,
      amount_base_currency: amountBaseCurrency
    };
  } catch (_error) {
    const fallbackDraft = hydrateFixedFxForDraft({
      ...draft,
      amount,
      currency,
      base_currency: baseCurrency
    });
    if (fallbackDraft?.fx_provider === "fixed_trip") return fallbackDraft;

    return {
      ...draft,
      amount,
      currency,
      base_currency: baseCurrency,
      fx_required: true,
      fx_rate: draft.fx_rate ?? null,
      fx_provider: draft.fx_provider ?? null,
      fx_rate_direction: draft.fx_rate_direction ?? null,
      fx_base_currency: draft.fx_base_currency ?? null,
      fx_quote_currency: draft.fx_quote_currency ?? null,
      amount_base_currency: draft.amount_base_currency ?? null
    };
  }
}

import {
  parseExpenseText,
  cleanTextForDescription,
  guessMerchant,
  guessCategory,
  overrideRelativeDate,
  validateDraft,
  round2
} from "./parsing.js";

function looksLikeMsiText(text) {
  const t = String(text || "").toLowerCase();
  return /\bmsi\b/.test(t) || /\bmeses?\s+sin\s+intereses?\b/.test(t) || /\d+\s*msi\b/.test(t);
}

export function parseJustMonths(text) {
  const t = String(text || "").toLowerCase().trim();
  const m = t.match(/(\d{1,2})/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 1 || n > 60) return null;
  return n;
}

export function createDraft(parsedExpense, options = {}) {
  const {
    text = "",
    activeTrip = null,
    requestId = null,
    parseMs = 0,
    forceMsi = false,
    allowedCategories,
    allowedPaymentMethods
  } = options;

  const draft = { ...parsedExpense };
  const wantsMsi = Boolean(forceMsi || draft.is_msi || looksLikeMsiText(text));

  draft.raw_text = text;
  draft.purchase_date = overrideRelativeDate(text, draft.purchase_date);
  draft.__perf = {
    parse_ms: parseMs,
    cache_hit: { card_rules: null, llm: null },
    request_id: requestId
  };

  if (wantsMsi) {
    draft.is_msi = true;
    draft.msi_total_amount = Number(draft.msi_total_amount || draft.amount_mxn);
  }

  draft.payment_method = null;
  draft.amex_ambiguous = false;

  const amountToken = draft.__meta?.amount_tokens?.[0] || "";
  draft.description = cleanTextForDescription(text, amountToken, null) || "Gasto";
  draft.merchant = guessMerchant(text) || "";
  draft.category = guessCategory(`${draft.merchant} ${draft.description}`, { allowedCategories });

  draft.active_trip_id = activeTrip?.tripId || null;
  draft.active_trip_name = activeTrip?.tripName || null;
  draft.active_trip_base_currency = activeTrip?.baseCurrency || null;
  draft.trip_id = activeTrip?.tripId || null;
  draft.trip_name = activeTrip?.tripName || null;

  if (draft.currency_explicit === false) {
    if (draft.trip_id && draft.active_trip_base_currency) {
      draft.currency = draft.active_trip_base_currency;
    } else {
      draft.currency = "MXN";
    }
  }

  const err = validateDraft(draft, { skipPaymentMethod: true, allowedCategories, allowedPaymentMethods });
  if (err) return { draft, error: err, wantsMsi };

  if (wantsMsi) {
    draft.is_msi = true;
    draft.msi_total_amount = Number(draft.msi_total_amount || draft.amount_mxn);
    if (!Number.isFinite(draft.msi_months) || draft.msi_months <= 1) {
      draft.msi_months = null;
      draft.__state = "awaiting_payment_method";
      return { draft, wantsMsi };
    }
    draft.amount_mxn = round2(Number(draft.msi_total_amount) / draft.msi_months);
    draft.__state = "awaiting_payment_method";
    return { draft, wantsMsi };
  }

  draft.is_msi = false;
  draft.msi_months = null;
  draft.msi_total_amount = null;
  draft.msi_start_month = null;
  draft.__state = "awaiting_payment_method";
  return { draft, wantsMsi };
}

export function applyDraftAction(draft, action) {
  if (!draft) return { draft: null, error: "No draft" };

  if (action?.type === "cancel") return { draft: null, canceled: true };

  const next = { ...draft };
  if (action?.type === "selectPaymentMethod") {
    next.payment_method = action.method;
    next.__state = "ready_to_confirm";
    return { draft: next };
  }

  if (action?.type === "toggleTripInclude") {
    if (action.include === false) {
      next.trip_id = null;
      next.trip_name = null;
      if (next.currency_explicit === false) next.currency = "MXN";
    } else {
      next.trip_id = next.active_trip_id || null;
      next.trip_name = next.active_trip_name || null;
      if (next.currency_explicit === false) next.currency = next.active_trip_base_currency || "MXN";
    }
    return { draft: next };
  }

  if (action?.type === "editField") {
    next[action.field] = action.value;
    return { draft: next };
  }

  if (action?.type === "setMsiMonths") {
    const n = Number(action.months);
    if (!Number.isFinite(n) || n <= 1 || n > 60) return { draft, error: "invalid_msi_months" };
    next.is_msi = true;
    next.msi_months = n;
    if (!next.msi_total_amount || Number(next.msi_total_amount) <= 0) {
      next.msi_total_amount = Number(next.amount_mxn);
    }
    next.amount_mxn = round2(Number(next.msi_total_amount) / n);
    next.__state = "ready_to_confirm";
    return { draft: next };
  }

  return { draft: next, error: "unknown_action" };
}

export function buildDraftFromText(text, options = {}) {
  const parsedExpense = parseExpenseText(text, options);
  return createDraft(parsedExpense, { ...options, text });
}

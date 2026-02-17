export const DraftState = Object.freeze({
  IDLE: "IDLE",
  PARSED: "PARSED",
  SELECT_METHOD: "SELECT_METHOD",
  CONFIRMATION: "CONFIRMATION"
});

export const DraftAction = Object.freeze({
  SELECT_PAYMENT_METHOD: "selectPaymentMethod",
  TOGGLE_TRIP_INCLUDE: "toggleTripInclude",
  EDIT_FIELD: "editField",
  CANCEL: "cancel",
  SET_MSI_MONTHS: "setMsiMonths"
});

export function createEmptyParsedExpense() {
  return {
    amount_mxn: NaN,
    currency: "MXN",
    currency_explicit: false,
    payment_method: "",
    category: "Other",
    purchase_date: "",
    merchant: "",
    description: "",
    is_msi: false,
    msi_months: null,
    msi_total_amount: null,
    msi_start_month: null,
    amex_ambiguous: false,
    __meta: { amount_tokens: [], amounts_found: 0, has_multiple_amounts: false }
  };
}

export function createEmptyDraft() {
  return {
    ...createEmptyParsedExpense(),
    raw_text: "",
    active_trip_id: null,
    active_trip_name: null,
    active_trip_base_currency: null,
    trip_id: null,
    trip_name: null,
    __state: "awaiting_payment_method"
  };
}

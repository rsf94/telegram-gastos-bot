import test from "node:test";
import assert from "node:assert/strict";

import {
  parseExpenseText,
  createDraft,
  applyDraftAction,
  parseJustMonths,
  step,
  DRAFT_STATES,
  overrideRelativeDate
} from "../index.js";

test("parseExpenseText parses amount, merchant hints and payment method", () => {
  const parsed = parseExpenseText("230 Uber American Express ayer");
  assert.equal(parsed.amount_mxn, 230);
  assert.equal(parsed.payment_method, "American Express");
  assert.equal(parsed.currency, "MXN");
  assert.equal(parsed.is_msi, false);
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(parsed.purchase_date));
});

test("MSI examples preserve total and months", () => {
  const parsed = parseExpenseText("1200 gasolinera 6 MSI BBVA Platino");
  assert.equal(parsed.is_msi, true);
  assert.equal(parsed.msi_total_amount, 1200);
  assert.equal(parsed.msi_months, 6);
  assert.equal(parsed.payment_method, "BBVA Platino");
});

test("foreign currency is detected", () => {
  const parsed = parseExpenseText("50 USD Uber");
  assert.equal(parsed.currency, "USD");
  assert.equal(parsed.currency_explicit, true);
});

test("createDraft and transitions mimic telegram flow", () => {
  const parsed = parseExpenseText("1200 gasolinera MSI");
  const { draft, wantsMsi, error } = createDraft(parsed, {
    text: "1200 gasolinera MSI",
    activeTrip: { tripId: "abc", tripName: "NYC", baseCurrency: "USD" }
  });

  assert.equal(error, undefined);
  assert.equal(wantsMsi, true);
  assert.equal(draft.__state, "awaiting_payment_method");
  assert.equal(draft.payment_method, null);
  assert.equal(draft.currency, "USD");

  const withMethod = applyDraftAction(draft, {
    type: "selectPaymentMethod",
    method: "American Express"
  }).draft;
  assert.equal(withMethod.payment_method, "American Express");

  const withMonths = applyDraftAction(withMethod, { type: "setMsiMonths", months: 6 }).draft;
  assert.equal(withMonths.msi_months, 6);
  assert.equal(withMonths.amount_mxn, 200);
});

test("trip include/exclude toggle follows explicit currency rule", () => {
  const parsed = parseExpenseText("500 uber");
  const { draft } = createDraft(parsed, {
    text: "500 uber",
    activeTrip: { tripId: "trip-1", tripName: "CDG", baseCurrency: "EUR" }
  });

  const excluded = applyDraftAction(draft, { type: "toggleTripInclude", include: false }).draft;
  assert.equal(excluded.trip_id, null);
  assert.equal(excluded.currency, "MXN");

  const included = applyDraftAction(excluded, { type: "toggleTripInclude", include: true }).draft;
  assert.equal(included.trip_id, "trip-1");
  assert.equal(included.currency, "EUR");
});

test("parseJustMonths validates range", () => {
  assert.equal(parseJustMonths("6 meses"), 6);
  assert.equal(parseJustMonths("1"), null);
  assert.equal(parseJustMonths("61"), null);
});

test("state machine transitions", () => {
  assert.equal(step(DRAFT_STATES.IDLE, { type: "PARSE_OK" }), DRAFT_STATES.PARSED);
  assert.equal(step(DRAFT_STATES.PARSED, { type: "REQUEST_METHOD" }), DRAFT_STATES.SELECT_METHOD);
  assert.equal(step(DRAFT_STATES.SELECT_METHOD, { type: "METHOD_SELECTED" }), DRAFT_STATES.CONFIRMATION);
  assert.equal(step(DRAFT_STATES.CONFIRMATION, { type: "CONFIRM" }), DRAFT_STATES.IDLE);
});

test("overrideRelativeDate keeps explicit date", () => {
  assert.equal(
    overrideRelativeDate("comida 2025-01-07", "2025-01-01"),
    "2025-01-07"
  );
});

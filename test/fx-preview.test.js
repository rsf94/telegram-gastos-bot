import test from "node:test";
import assert from "node:assert/strict";

import { preview, renderFxBlock } from "../src/parsing.js";

function baseDraft(overrides = {}) {
  return {
    amount: 100,
    amount_mxn: 100,
    currency: "MXN",
    base_currency: "MXN",
    amount_base_currency: 100,
    fx_rate: 1,
    fx_provider: null,
    fx_required: false,
    is_msi: false,
    msi_months: null,
    payment_method: "BBVA",
    purchase_date: "2026-01-15",
    category: "Comida",
    description: "Tacos",
    ...overrides
  };
}

test("JPY → MXN muestra conversión", () => {
  const text = preview(
    baseDraft({
      amount: 100,
      amount_mxn: 100,
      currency: "JPY",
      base_currency: "MXN",
      amount_base_currency: 11.11,
      fx_rate: 9,
      fx_provider: "fixed_trip",
      fx_required: true
    })
  );

  assert.match(text, /100 JPY ≈ MXN 11\.11/);
  assert.match(text, /FX fijo: 1 MXN = 9 JPY/);
  assert.match(text, /provider fixed_trip/);
});

test("USD → MXN muestra conversión", () => {
  const text = preview(
    baseDraft({
      amount: 500,
      amount_mxn: 500,
      currency: "USD",
      base_currency: "MXN",
      amount_base_currency: 8500,
      fx_rate: 17,
      fx_provider: "mock",
      fx_required: true
    })
  );

  assert.match(text, /500 USD ≈ MXN 8,500/);
  assert.match(text, /rate 17/);
});

test("MXN → MXN no muestra conversión", () => {
  const text = preview(
    baseDraft({
      currency: "MXN",
      base_currency: "MXN",
      amount_base_currency: 300,
      fx_rate: 1,
      fx_required: false
    })
  );

  assert.doesNotMatch(text, /≈ MXN/);
  assert.doesNotMatch(text, /1 MXN =/);
});

test("MSI + FX muestra total convertido", () => {
  const text = preview(
    baseDraft({
      amount: 900,
      amount_mxn: 300,
      currency: "USD",
      base_currency: "MXN",
      amount_base_currency: 15300,
      fx_rate: 17,
      fx_provider: "mock",
      fx_required: true,
      is_msi: true,
      msi_months: 3,
      msi_total_amount: 900
    })
  );

  assert.match(text, /≈ MXN 15,300/);
  assert.match(text, /≈ MXN 5,100 \/ mes/);
});

test("Confirm preview no altera valores FX", () => {
  const draft = baseDraft({
    amount: 500,
    currency: "USD",
    base_currency: "MXN",
    amount_base_currency: 8500,
    fx_rate: 17,
    fx_provider: "mock",
    fx_required: true
  });
  const snapshot = structuredClone(draft);

  preview(draft);
  renderFxBlock(draft);

  assert.deepEqual(draft, snapshot);
});

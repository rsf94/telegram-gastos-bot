import test from "node:test";
import assert from "node:assert/strict";

import { ensureDraftFx } from "../src/usecases/ensure_draft_fx.js";
import { preview } from "../src/parsing.js";
import { createCallbackHandler } from "../src/handlers/callbacks.js";
import { __resetState, setDraft } from "../src/state.js";
import { __resolveBaseAmountForExpense } from "../src/storage/bigquery.js";

test("Draft + preview: 100JPY sushi usa FX fijo y muestra bloque", async () => {
  const draft = await ensureDraftFx({
    amount: 100,
    amount_mxn: 100,
    currency: "JPY",
    base_currency: "MXN",
    purchase_date: "2026-01-15",
    payment_method: "BBVA",
    category: "Comida",
    description: "sushi",
    is_msi: false
  });

  assert.equal(draft.fx_required, true);
  assert.equal(draft.amount_base_currency, 11.11);
  assert.equal(draft.fx_rate, 9);
  assert.equal(draft.fx_provider, "fixed_trip");

  const text = preview(draft);
  assert.match(text, /100 JPY ≈ MXN 11\.11/);
  assert.match(text, /FX fijo: 1 MXN = 9 JPY/);
});

test("Confirm mapping: usa amount_base_currency para amount_mxn lógico y preserva FX metadata", async () => {
  __resetState();
  const calls = [];
  setDraft("77", {
    amount: 100,
    amount_mxn: 100,
    currency: "JPY",
    base_currency: "MXN",
    purchase_date: "2026-01-15",
    payment_method: "BBVA",
    category: "Comida",
    description: "sushi",
    is_msi: false,
    fx_required: true,
    fx_rate: 9,
    fx_provider: "fixed_trip",
    amount_base_currency: 11.11
  });

  const handler = createCallbackHandler({
    sendMessage: async () => {},
    editMessage: async () => {},
    answerCallback: async () => {},
    resolveActiveTripForChatFn: async () => null,
    saveExpenseFn: async ({ draft }) => {
      calls.push(draft);
      return { ok: true, expenseId: "exp-1" };
    }
  });

  await handler({ id: "cb-1", data: "confirm", message: { chat: { id: 77 }, message_id: 1 } });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].currency, "JPY");
  assert.equal(calls[0].base_currency, "MXN");
  assert.equal(calls[0].fx_required, true);
  assert.equal(calls[0].fx_rate, 9);
  assert.equal(calls[0].fx_provider, "fixed_trip");
  assert.equal(calls[0].amount_base_currency, 11.11);
  assert.equal(__resolveBaseAmountForExpense(calls[0]), 11.11);
});

test("Caso MXN: no muestra FX y amount_mxn lógico se mantiene igual", async () => {
  const draft = await ensureDraftFx({
    amount: 100,
    amount_mxn: 100,
    currency: "MXN",
    base_currency: "MXN",
    purchase_date: "2026-01-15",
    payment_method: "BBVA",
    category: "Comida",
    description: "tacos",
    is_msi: false,
    fx_required: true,
    fx_rate: 0.12,
    fx_provider: "mock",
    amount_base_currency: 12
  });

  assert.equal(draft.fx_required, false);
  assert.equal(__resolveBaseAmountForExpense(draft), 100);
  const text = preview(draft);
  assert.doesNotMatch(text, /≈/);
  assert.doesNotMatch(text, /FX fijo:/);
});

import test from "node:test";
import assert from "node:assert/strict";

import { ensureDraftFx } from "../src/usecases/ensure_draft_fx.js";
import { preview } from "../src/parsing.js";
import { createCallbackHandler } from "../src/handlers/callbacks.js";
import { __resetState, setDraft } from "../src/state.js";
import {
  __resolveAmountMxnForExpense,
  __resolveBaseAmountForExpense
} from "../src/storage/bigquery.js";

test("Draft/preview: 200 JPY con base MXN usa Frankfurter y muestra conversión", async () => {
  const draft = await ensureDraftFx(
    {
      amount: 200,
      amount_mxn: 200,
      currency: "JPY",
      base_currency: "MXN",
      purchase_date: "2026-01-15",
      payment_method: "BBVA",
      category: "Comida",
      description: "prueba",
      is_msi: false
    },
    {
      fxClient: {
        getFxRate: async () => ({ rate: 8.9, provider: "frankfurter" })
      }
    }
  );

  assert.equal(draft.fx_provider, "frankfurter");
  assert.equal(draft.fx_rate, 8.9);
  assert.equal(draft.fx_rate_direction, "quote_per_base");
  assert.equal(draft.fx_base_currency, "MXN");
  assert.equal(draft.fx_quote_currency, "JPY");
  assert.equal(draft.amount_base_currency, 22.47);

  const text = preview(draft);
  assert.match(text, /200 JPY ≈ MXN 22\.47/);
  assert.match(text, /provider frankfurter/);
});

test("Persistencia: confirmar guarda amount_mxn en MXN y no el monto JPY original", async () => {
  __resetState();
  const calls = [];
  setDraft("77", {
    amount: 200,
    amount_mxn: 200,
    currency: "JPY",
    base_currency: "MXN",
    purchase_date: "2026-01-15",
    payment_method: "BBVA",
    category: "Comida",
    description: "sushi",
    is_msi: false,
    fx_required: true,
    fx_rate: 8.9,
    fx_provider: "frankfurter",
    fx_rate_direction: "quote_per_base",
    fx_base_currency: "MXN",
    fx_quote_currency: "JPY",
    amount_base_currency: 22.47
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
  assert.equal(__resolveBaseAmountForExpense(calls[0]), 22.47);
  assert.equal(__resolveAmountMxnForExpense(calls[0]), 22.47);
  assert.notEqual(__resolveAmountMxnForExpense(calls[0]), 200);
});

test("Fallback: si falla Frankfurter para JPY/MXN usa fixed_trip", async () => {
  const draft = await ensureDraftFx(
    {
      amount: 200,
      amount_mxn: 200,
      currency: "JPY",
      base_currency: "MXN",
      purchase_date: "2026-01-15",
      payment_method: "BBVA",
      category: "Comida",
      description: "prueba",
      is_msi: false
    },
    {
      fxClient: {
        getFxRate: async () => {
          throw new Error("network down");
        }
      }
    }
  );

  assert.equal(draft.fx_provider, "fixed_trip");
  assert.equal(draft.fx_rate, 9);
  assert.equal(draft.amount_base_currency, 22.22);
});

test("Dirección: 200 MXN con base JPY muestra MXN ≈ JPY consistente", async () => {
  const draft = await ensureDraftFx(
    {
      amount: 200,
      amount_mxn: 200,
      currency: "MXN",
      currency_explicit: true,
      base_currency: "JPY",
      trip_id: "trip-1",
      purchase_date: "2026-01-15",
      payment_method: "BBVA",
      category: "Transporte",
      description: "gas",
      is_msi: false
    },
    {
      fxClient: {
        getFxRate: async () => ({ rate: 8.9, provider: "frankfurter" })
      }
    }
  );

  const text = preview(draft);
  assert.match(text, /200 MXN ≈ JPY 22\.47/);
  assert.equal(draft.amount_base_currency, 22.47);
  assert.match(text, /rate 8\.9 \(MXN\/JPY, quote_per_base\)/);
});

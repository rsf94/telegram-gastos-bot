import test from "node:test";
import assert from "node:assert/strict";

import {
  createTrip,
  setActiveTrip,
  getActiveTripId
} from "../src/storage/bigquery.js";
import { saveExpense } from "../src/usecases/save_expense.js";
import { createMessageHandler } from "../src/handlers/messages.js";
import { createCallbackHandler } from "../src/handlers/callbacks.js";
import { __resetConfirmIdempotency } from "../src/cache/confirm_idempotency.js";
import { __resetState, getDraft } from "../src/state.js";

function createMessageSpy() {
  const messages = [];
  return {
    messages,
    sendMessage: async (chatId, text, extra) => {
      messages.push({ chatId, text, extra });
    }
  };
}

test("createTrip genera uuid e inserta columnas esperadas", async () => {
  const inserts = [];
  const tableClient = {
    insert: async (rows) => {
      inserts.push(rows);
    }
  };

  const trip = await createTrip(
    {
      chat_id: "123",
      name: "Japón",
      base_currency: "JPY",
      metadata: { source: "test" }
    },
    { tableClient }
  );

  assert.equal(inserts.length, 1);
  const row = inserts[0][0];
  assert.match(row.trip_id, /^[0-9a-f-]{36}$/i);
  assert.equal(row.chat_id, "123");
  assert.equal(row.name, "Japón");
  assert.equal(row.base_currency, "JPY");
  assert.equal(typeof row.created_at, "string");
  assert.equal(row.updated_at, null);
  assert.equal(row.metadata, JSON.stringify({ source: "test" }));
  assert.equal(trip.trip_id, row.trip_id);
});

test("setActiveTrip inserta evento append-only", async () => {
  const inserts = [];
  const tableClient = {
    insert: async (rows) => {
      inserts.push(rows);
    }
  };

  await setActiveTrip({ chat_id: "321", trip_id: "trip-1" }, { tableClient });
  await setActiveTrip({ chat_id: "321", trip_id: "trip-2" }, { tableClient });

  assert.equal(inserts.length, 2);
  assert.equal(inserts[0][0].active_trip_id, "trip-1");
  assert.equal(inserts[1][0].active_trip_id, "trip-2");
  assert.ok(inserts[0][0].set_at);
});

test("getActiveTripId regresa null cuando no hay filas", async () => {
  let querySeen = null;
  const bigqueryClient = {
    createQueryJob: async (options) => {
      querySeen = options.query;
      return [
        {
          getQueryResults: async () => [[]]
        }
      ];
    }
  };

  const activeTripId = await getActiveTripId("999", { bigqueryClient });
  assert.equal(activeTripId, null);
  assert.match(querySeen, /trip_state/);
});

test("saveExpense incluye trip_id del draft cuando aplica", async () => {
  __resetConfirmIdempotency();
  const { sendMessage } = createMessageSpy();
  const calls = [];

  const draft = {
    raw_text: "cafe 80",
    purchase_date: "2024-01-01",
    payment_method: "BBVA Platino",
    amount_mxn: 80,
    category: "Other",
    merchant: "",
    description: "",
    is_msi: false,
    msi_months: null,
    msi_total_amount: null,
    trip_id: "trip-active-1",
    trip_name: "Japon_2026",
    __perf: { parse_ms: 1, cache_hit: { card_rules: true, llm: null } }
  };

  await saveExpense({
    chatId: "50",
    draft,
    sendMessage,
    insertExpense: async (insertDraft) => {
      calls.push(insertDraft);
      return "exp-trip-1";
    },
    updateExpenseEnrichmentFn: async () => {},
    enrichExpenseLLMFn: async ({ baseDraft }) => ({
      llm_provider: "local",
      category: baseDraft.category,
      merchant: baseDraft.merchant,
      description: baseDraft.description,
      cache_hit: false
    }),
    llmProviderEnv: "local"
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].trip_id, "trip-active-1");
});

test("draft y confirmación muestran viaje activo", async () => {
  __resetState();
  const { sendMessage, messages } = createMessageSpy();

  const handler = createMessageHandler({
    sendMessage,
    getActiveCardNamesFn: async () => ["BBVA Platino"],
    resolveActiveTripForChatFn: async () => ({
      trip_id: "9baf6887-aaaa-bbbb-cccc-111111111111",
      trip_name: "Japon_2026"
    })
  });

  await handler({ chat: { id: 501 }, text: "200 JPY ramen" });
  const draft = getDraft("501");
  assert.equal(draft.trip_id, "9baf6887-aaaa-bbbb-cccc-111111111111");
  assert.equal(draft.trip_name, "Japon_2026");

  const callbackHandler = createCallbackHandler({
    sendMessage,
    editMessage: async (_chatId, _messageId, text) => {
      messages.push({ text });
    },
    answerCallback: async () => {},
    getActiveCardNamesFn: async () => ["BBVA Platino"]
  });

  await callbackHandler({
    id: "cb-trip-1",
    data: "payment_method|BBVA Platino",
    message: { chat: { id: 501 }, message_id: 10 }
  });
  assert.ok(messages.at(-1).text.includes("Viaje:"));
  assert.ok(messages.at(-1).text.includes("Japon_2026"));
});

test("tap en No es del viaje excluye trip_id y muestra botón para reactivar", async () => {
  __resetState();
  const { sendMessage, messages } = createMessageSpy();

  const handler = createMessageHandler({
    sendMessage,
    getActiveCardNamesFn: async () => ["BBVA Platino"],
    resolveActiveTripForChatFn: async () => ({
      trip_id: "9baf6887-aaaa-bbbb-cccc-111111111111",
      trip_name: "Japon_2026"
    })
  });

  await handler({ chat: { id: 777 }, text: "200 ramen" });

  const callbackHandler = createCallbackHandler({
    sendMessage,
    editMessage: async (_chatId, _messageId, text, extra) => {
      messages.push({ text, extra });
    },
    answerCallback: async () => {},
    getActiveCardNamesFn: async () => ["BBVA Platino"]
  });

  await callbackHandler({
    id: "cb-trip-pay-1",
    data: "payment_method|BBVA Platino",
    message: { chat: { id: 777 }, message_id: 10 }
  });

  const beforeToggle = messages.at(-1);
  assert.ok(beforeToggle.extra.reply_markup.inline_keyboard.flat().some((btn) => btn.text === "🚫 No es del viaje"));

  await callbackHandler({
    id: "cb-trip-toggle-1",
    data: "trip_exclude",
    message: { chat: { id: 777 }, message_id: 10 }
  });

  const draftAfterExclude = getDraft("777");
  assert.equal(draftAfterExclude.trip_id, null);
  assert.equal(draftAfterExclude.trip_name, null);

  const afterToggle = messages.at(-1);
  assert.ok(afterToggle.extra.reply_markup.inline_keyboard.flat().some((btn) => btn.text === "↩️ Sí es del viaje"));
  assert.ok(afterToggle.text.includes("Viaje: <b>Japon_2026</b>"));
});

test("sin viaje activo no muestra botones extras de viaje", async () => {
  __resetState();
  const { sendMessage, messages } = createMessageSpy();

  const handler = createMessageHandler({
    sendMessage,
    getActiveCardNamesFn: async () => ["BBVA Platino"],
    resolveActiveTripForChatFn: async () => null
  });

  await handler({ chat: { id: 778 }, text: "200 ramen" });

  const callbackHandler = createCallbackHandler({
    sendMessage,
    editMessage: async (_chatId, _messageId, text, extra) => {
      messages.push({ text, extra });
    },
    answerCallback: async () => {},
    getActiveCardNamesFn: async () => ["BBVA Platino"]
  });

  await callbackHandler({
    id: "cb-trip-pay-2",
    data: "payment_method|BBVA Platino",
    message: { chat: { id: 778 }, message_id: 11 }
  });

  const keyboard = messages.at(-1).extra.reply_markup.inline_keyboard.flat().map((btn) => btn.text);
  assert.equal(keyboard.includes("🚫 No es del viaje"), false);
  assert.equal(keyboard.includes("↩️ Sí es del viaje"), false);
  const draft = getDraft("778");
  assert.equal(draft.trip_id, null);
  assert.equal(draft.active_trip_id, null);
});

test("confirmar guarda sin trip_id cuando el usuario excluye viaje", async () => {
  __resetState();
  const { sendMessage } = createMessageSpy();
  const savedDrafts = [];

  const handler = createMessageHandler({
    sendMessage,
    getActiveCardNamesFn: async () => ["BBVA Platino"],
    resolveActiveTripForChatFn: async () => ({
      trip_id: "trip-active-x",
      trip_name: "Chile"
    })
  });

  await handler({ chat: { id: 779 }, text: "350 cena" });

  const callbackHandler = createCallbackHandler({
    sendMessage,
    editMessage: async () => {},
    answerCallback: async () => {},
    getActiveCardNamesFn: async () => ["BBVA Platino"],
    saveExpenseFn: async ({ draft }) => {
      savedDrafts.push({ ...draft });
      return { ok: true, expenseId: "exp-779" };
    }
  });

  await callbackHandler({
    id: "cb-trip-pay-3",
    data: "payment_method|BBVA Platino",
    message: { chat: { id: 779 }, message_id: 12 }
  });
  await callbackHandler({
    id: "cb-trip-toggle-3",
    data: "trip_exclude",
    message: { chat: { id: 779 }, message_id: 12 }
  });
  await callbackHandler({
    id: "cb-trip-confirm-3",
    data: "confirm",
    message: { chat: { id: 779 }, message_id: 12 }
  });

  assert.equal(savedDrafts.length, 1);
  assert.equal(savedDrafts[0].trip_id, null);
  assert.equal(savedDrafts[0].active_trip_id, "trip-active-x");
});

test("saveExpense no truena sin viaje activo y no inserta trip_id", async () => {
  __resetConfirmIdempotency();
  const { sendMessage } = createMessageSpy();
  const calls = [];
  const draft = {
    raw_text: "cafe 80",
    purchase_date: "2024-01-01",
    payment_method: "BBVA Platino",
    amount_mxn: 80,
    category: "Other",
    merchant: "",
    description: "",
    is_msi: false,
    msi_months: null,
    msi_total_amount: null,
    __perf: { parse_ms: 1, cache_hit: { card_rules: true, llm: null } }
  };

  const result = await saveExpense({
    chatId: "51",
    draft,
    sendMessage,
    insertExpense: async (insertDraft) => {
      calls.push(insertDraft);
      return "exp-no-trip-1";
    },
    updateExpenseEnrichmentFn: async () => {},
    enrichExpenseLLMFn: async ({ baseDraft }) => ({
      llm_provider: "local",
      category: baseDraft.category,
      merchant: baseDraft.merchant,
      description: baseDraft.description,
      cache_hit: false
    }),
    llmProviderEnv: "local"
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal("trip_id" in calls[0], false);
});

test("/viaje nuevo y /viaje actual funcionan en smoke", async () => {
  __resetState();
  const { sendMessage, messages } = createMessageSpy();

  const handler = createMessageHandler({
    sendMessage,
    createTripFn: async ({ chat_id, name }) => ({
      trip_id: "123e4567-e89b-12d3-a456-426614174000",
      chat_id,
      name
    }),
    setActiveTripFn: async () => {},
    getActiveTripIdFn: async () => "123e4567-e89b-12d3-a456-426614174000",
    listTripsFn: async () => [
      {
        trip_id: "123e4567-e89b-12d3-a456-426614174000",
        name: "Viaje CDMX"
      }
    ]
  });

  await handler({ chat: { id: 88 }, text: "/viaje nuevo Viaje CDMX" });
  await handler({ chat: { id: 88 }, text: "/viaje actual" });

  assert.ok(messages[0].text.includes("Viaje activo"));
  assert.ok(messages[1].text.includes("Viaje CDMX"));
  assert.ok(messages[1].text.includes("123e4567-e89b-12d3-a456-426614174000"));
});

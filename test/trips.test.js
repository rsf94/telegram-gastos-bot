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
import { __resetActiveTripCache, setActiveTripCache, getActiveTripCache } from "../src/cache/active_trip_cache.js";

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
  __resetActiveTripCache();
  const { sendMessage, messages } = createMessageSpy();

  const handler = createMessageHandler({
    sendMessage,
    getActiveCardNamesFn: async () => ["BBVA Platino"]
  });

  setActiveTripCache("501", {
    tripId: "9baf6887-aaaa-bbbb-cccc-111111111111",
    tripName: "Japon_2026",
    baseCurrency: "JPY"
  });

  await handler({ chat: { id: 501 }, text: "200 JPY ramen" });
  const draft = getDraft("501");
  assert.equal(draft.trip_id, "9baf6887-aaaa-bbbb-cccc-111111111111");
  assert.equal(draft.trip_name, "Japon_2026");
  assert.equal(draft.currency, "JPY");
  assert.equal(draft.currency_explicit, true);

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
  __resetActiveTripCache();
  const { sendMessage, messages } = createMessageSpy();

  const handler = createMessageHandler({
    sendMessage,
    getActiveCardNamesFn: async () => ["BBVA Platino"]
  });

  setActiveTripCache("777", {
    tripId: "9baf6887-aaaa-bbbb-cccc-111111111111",
    tripName: "Japon_2026",
    baseCurrency: "JPY"
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
  assert.equal(draftAfterExclude.currency, "MXN");

  const afterToggle = messages.at(-1);
  assert.ok(afterToggle.extra.reply_markup.inline_keyboard.flat().some((btn) => btn.text === "↩️ Sí es del viaje"));
  assert.ok(afterToggle.text.includes("Viaje: <b>Japon_2026 (excluido)</b>"));

  await callbackHandler({
    id: "cb-trip-toggle-1b",
    data: "trip_include",
    message: { chat: { id: 777 }, message_id: 10 }
  });

  const draftAfterInclude = getDraft("777");
  assert.equal(draftAfterInclude.trip_id, "9baf6887-aaaa-bbbb-cccc-111111111111");
  assert.equal(draftAfterInclude.currency, "JPY");
});

test("moneda explícita se respeta aunque se excluya/incluya viaje", async () => {
  __resetState();
  __resetActiveTripCache();
  const { sendMessage } = createMessageSpy();

  const handler = createMessageHandler({
    sendMessage,
    getActiveCardNamesFn: async () => ["BBVA Platino"]
  });

  setActiveTripCache("7780", {
    tripId: "trip-usd-1",
    tripName: "NYC",
    baseCurrency: "JPY"
  });

  await handler({ chat: { id: 7780 }, text: "10 USD taxi" });

  const callbackHandler = createCallbackHandler({
    sendMessage,
    editMessage: async () => {},
    answerCallback: async () => {},
    getActiveCardNamesFn: async () => ["BBVA Platino"]
  });

  await callbackHandler({
    id: "cb-trip-usd-pay",
    data: "payment_method|BBVA Platino",
    message: { chat: { id: 7780 }, message_id: 111 }
  });

  await callbackHandler({
    id: "cb-trip-usd-toggle-a",
    data: "trip_exclude",
    message: { chat: { id: 7780 }, message_id: 111 }
  });

  await callbackHandler({
    id: "cb-trip-usd-toggle-b",
    data: "trip_include",
    message: { chat: { id: 7780 }, message_id: 111 }
  });

  const draft = getDraft("7780");
  assert.equal(draft.currency, "USD");
  assert.equal(draft.currency_explicit, true);
});

test("sin viaje activo no muestra botones extras de viaje", async () => {
  __resetState();
  __resetActiveTripCache();
  const { sendMessage, messages } = createMessageSpy();

  const handler = createMessageHandler({
    sendMessage,
    getActiveCardNamesFn: async () => ["BBVA Platino"]
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
  __resetActiveTripCache();
  const { sendMessage } = createMessageSpy();
  const savedDrafts = [];

  const handler = createMessageHandler({
    sendMessage,
    getActiveCardNamesFn: async () => ["BBVA Platino"]
  });

  setActiveTripCache("779", { tripId: "trip-active-x", tripName: "Chile", baseCurrency: "CLP" });

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
  assert.equal(savedDrafts[0].currency, "MXN");
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

test("/viaje nuevo solicita moneda y crea viaje solo con ISO válido", async () => {
  __resetState();
  __resetActiveTripCache();
  const { sendMessage, messages } = createMessageSpy();
  const createCalls = [];
  const setCalls = [];

  const handler = createMessageHandler({
    sendMessage,
    createTripFn: async (payload) => {
      createCalls.push(payload);
      return {
        trip_id: "123e4567-e89b-12d3-a456-426614174000",
        chat_id: payload.chat_id,
        name: payload.name,
        base_currency: payload.base_currency
      };
    },
    setActiveTripFn: async (payload) => {
      setCalls.push(payload);
    },
    getActiveTripIdFn: async () => "123e4567-e89b-12d3-a456-426614174000",
    listTripsFn: async () => [
      {
        trip_id: "123e4567-e89b-12d3-a456-426614174000",
        name: "Viaje CDMX",
        base_currency: "JPY"
      }
    ]
  });

  await handler({ chat: { id: 88 }, text: "/viaje nuevo Viaje CDMX" });
  assert.ok(messages[0].text.includes("¿En qué moneda"));
  assert.equal(createCalls.length, 0);

  await handler({ chat: { id: 88 }, text: "JP" });
  assert.ok(messages[1].text.includes("Código inválido"));
  assert.equal(createCalls.length, 0);

  await handler({ chat: { id: 88 }, text: "jpy" });
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].base_currency, "JPY");
  assert.equal(setCalls.length, 1);
  assert.equal(setCalls[0].trip_id, "123e4567-e89b-12d3-a456-426614174000");
  assert.equal(getActiveTripCache("88")?.baseCurrency, "JPY");

  await handler({ chat: { id: 88 }, text: "/viaje actual" });
  assert.ok(messages[2].text.includes("Moneda base: <b>JPY</b>"));
  assert.ok(messages[3].text.includes("Viaje CDMX"));
  assert.ok(messages[3].text.includes("123e4567-e89b-12d3-a456-426614174000"));
});
test("flujo de gasto usa cache de viaje y no consulta BigQuery en hot-path", async () => {
  __resetState();
  __resetActiveTripCache();
  setActiveTripCache("901", { tripId: "trip-cache-1", tripName: "Roma", baseCurrency: "JPY" });

  let activeTripLookups = 0;
  const { sendMessage } = createMessageSpy();
  const handler = createMessageHandler({
    sendMessage,
    getActiveCardNamesFn: async () => ["BBVA Platino"],
    getActiveTripIdFn: async () => {
      activeTripLookups += 1;
      return "should-not-be-used";
    }
  });

  await handler({ chat: { id: 901 }, text: "100 uber eats" });

  const draft = getDraft("901");
  assert.equal(draft.trip_id, "trip-cache-1");
  assert.equal(draft.trip_name, "Roma");
  assert.equal(draft.currency, "JPY");
  assert.equal(draft.currency_explicit, false);
  assert.equal(activeTripLookups, 0);
});

test("sin cache de viaje el draft queda sin trip_id y no consulta BigQuery", async () => {
  __resetState();
  __resetActiveTripCache();

  let activeTripLookups = 0;
  const { sendMessage } = createMessageSpy();
  const handler = createMessageHandler({
    sendMessage,
    getActiveCardNamesFn: async () => ["BBVA Platino"],
    getActiveTripIdFn: async () => {
      activeTripLookups += 1;
      return "should-not-be-used";
    }
  });

  await handler({ chat: { id: 902 }, text: "100 uber eats" });

  const draft = getDraft("902");
  assert.equal(draft.trip_id, null);
  assert.equal(draft.active_trip_id, null);
  assert.equal(draft.currency, "MXN");
  assert.equal(activeTripLookups, 0);
});

test("/viaje apagar persiste sentinel append-only y limpia cache", async () => {
  __resetState();
  __resetActiveTripCache();
  setActiveTripCache("903", { tripId: "trip-old", tripName: "Old", baseCurrency: "USD" });

  const { sendMessage, messages } = createMessageSpy();
  const setCalls = [];

  const handler = createMessageHandler({
    sendMessage,
    setActiveTripFn: async (payload) => {
      setCalls.push(payload);
    }
  });

  await handler({ chat: { id: 903 }, text: "/viaje apagar" });

  assert.equal(setCalls.length, 1);
  assert.equal(setCalls[0].trip_id, null);

  const activeTripId = await getActiveTripId("903", {
    bigqueryClient: {
      createQueryJob: async () => [
        {
          getQueryResults: async () => [[{ active_trip_id: "__NONE__" }]]
        }
      ]
    }
  });
  assert.equal(activeTripId, null);
  assert.equal(getActiveTripCache("903")?.tripId ?? null, null);
  assert.ok(messages.at(-1).text.includes("Viaje activo apagado"));
});

test("perf logging de expense_draft incluye estructura esperada", async () => {
  __resetState();
  __resetActiveTripCache();

  const logs = [];
  const originalLog = console.log;
  console.log = (line) => logs.push(line);

  try {
    const { sendMessage } = createMessageSpy();
    const handler = createMessageHandler({
      sendMessage,
      getActiveCardNamesFn: async () => ["BBVA Platino"]
    });

    await handler({ chat: { id: 904 }, text: "100 uber eats" }, { requestId: "req-1" });
  } finally {
    console.log = originalLog;
  }

  const perfLogLine = logs
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .find((entry) => entry?.type === "perf" && entry?.flow === "expense_draft");

  assert.ok(perfLogLine);
  assert.equal(perfLogLine.chat_id, "904");
  assert.equal(typeof perfLogLine.ms_total, "number");
  assert.equal(typeof perfLogLine.ms_parse, "number");
  assert.equal(typeof perfLogLine.ms_ui_render, "number");
  assert.equal(typeof perfLogLine.ms_any_bq, "number");
});

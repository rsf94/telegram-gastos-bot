import test from "node:test";
import assert from "node:assert/strict";

import { createMessageHandler } from "../src/handlers/messages.js";
import { createCallbackHandler } from "../src/handlers/callbacks.js";
import {
  getDraft,
  getPendingDelete,
  __resetState
} from "../src/state.js";
import { guessCategory } from "../src/parsing.js";

function createMessageSpy() {
  const messages = [];
  const sendMessage = async (chatId, text, extra) => {
    messages.push({ chatId, text, extra });
  };
  return { sendMessage, messages };
}

function createAnswerSpy() {
  const calls = [];
  const answerCallback = async (id) => {
    calls.push(id);
  };
  return { answerCallback, calls };
}

test("normal flow", async () => {
  __resetState();
  const { sendMessage, messages } = createMessageSpy();
  const handler = createMessageHandler({
    sendMessage,
    getActiveCardNamesFn: async () => ["BBVA Platino"]
  });

  await handler({ chat: { id: 1 }, text: "230 Uber American Express ayer" });

  const draft = getDraft("1");
  assert.ok(draft);
  assert.equal(draft.is_msi, false);
  assert.equal(draft.__state, "awaiting_payment_method");
  assert.ok(messages.at(-1).text.includes("Confirmar gasto"));
});

test("msi step1 prompts for months", async () => {
  __resetState();
  const { sendMessage, messages } = createMessageSpy();
  const handler = createMessageHandler({
    sendMessage,
    getActiveCardNamesFn: async () => []
  });

  await handler({ chat: { id: 2 }, text: "gasolina 1200 BBVA Platino a MSI" });

  const draft = getDraft("2");
  assert.equal(draft.__state, "awaiting_msi_months");
  assert.ok(messages.at(-1).text.includes("Detecté"));
});

test("msi step2 stores months and monthly amount", async () => {
  __resetState();
  const { sendMessage } = createMessageSpy();
  const handler = createMessageHandler({
    sendMessage,
    getActiveCardNamesFn: async () => ["BBVA Platino"]
  });

  await handler({ chat: { id: 3 }, text: "gasolina 1200 BBVA Platino a MSI" });
  await handler({ chat: { id: 3 }, text: "6" });

  const draft = getDraft("3");
  assert.equal(draft.msi_months, 6);
  assert.equal(draft.amount_mxn, 200);
  assert.equal(draft.__state, "awaiting_payment_method");
});

test("explicit date is preserved", async () => {
  __resetState();
  const { sendMessage } = createMessageSpy();
  const handler = createMessageHandler({
    sendMessage,
    getActiveCardNamesFn: async () => ["BBVA Platino"]
  });

  await handler({ chat: { id: 4 }, text: "100 Oxxo BBVA Platino 2024-10-01" });

  const draft = getDraft("4");
  assert.equal(draft.purchase_date, "2024-10-01");
});

test("delete confirm removes pending delete", async () => {
  __resetState();
  const { sendMessage, messages } = createMessageSpy();
  const { answerCallback } = createAnswerSpy();
  const expenseId = "123e4567-e89b-12d3-a456-426614174000";

  const handler = createMessageHandler({
    sendMessage,
    getExpenseByIdFn: async () => ({
      id: expenseId,
      amount_mxn: "100",
      payment_method: "BBVA",
      purchase_date: "2024-01-01",
      category: "Other",
      description: "Test",
      is_msi: false
    }),
    countInstallmentsForExpenseFn: async () => 2
  });

  await handler({ chat: { id: 6 }, text: `borrar ${expenseId}` });
  assert.ok(getPendingDelete("6"));

  const callbackHandler = createCallbackHandler({
    sendMessage,
    answerCallback,
    deleteExpenseFn: async ({ chatId, pendingDelete }) => {
      await sendMessage(
        chatId,
        `✅ <b>Borrado</b>. Installments eliminados: ${pendingDelete.installmentsCount}.`
      );
      return { ok: true, result: { deletedInstallments: pendingDelete.installmentsCount } };
    }
  });

  await callbackHandler({
    id: "cb1",
    data: "delete_confirm",
    message: { chat: { id: 6 } }
  });

  assert.equal(getPendingDelete("6"), undefined);
  assert.ok(messages.at(-1).text.includes("Borrado"));
});

test("delete cancel clears pending delete", async () => {
  __resetState();
  const { sendMessage, messages } = createMessageSpy();
  const { answerCallback } = createAnswerSpy();
  const expenseId = "123e4567-e89b-12d3-a456-426614174000";

  const handler = createMessageHandler({
    sendMessage,
    getExpenseByIdFn: async () => ({
      id: expenseId,
      amount_mxn: "100",
      payment_method: "BBVA",
      purchase_date: "2024-01-01",
      category: "Other",
      description: "Test",
      is_msi: false
    }),
    countInstallmentsForExpenseFn: async () => 0
  });

  await handler({ chat: { id: 7 }, text: `borrar ${expenseId}` });
  assert.ok(getPendingDelete("7"));

  const callbackHandler = createCallbackHandler({
    sendMessage,
    answerCallback
  });

  await callbackHandler({
    id: "cb2",
    data: "delete_cancel",
    message: { chat: { id: 7 } }
  });

  assert.equal(getPendingDelete("7"), undefined);
  assert.ok(messages.at(-1).text.includes("Cancelado"));
});

test("cancel draft clears state", async () => {
  __resetState();
  const { sendMessage, messages } = createMessageSpy();
  const handler = createMessageHandler({
    sendMessage,
    getActiveCardNamesFn: async () => ["BBVA Platino"]
  });

  await handler({ chat: { id: 8 }, text: "230 Uber American Express ayer" });
  assert.ok(getDraft("8"));

  await handler({ chat: { id: 8 }, text: "cancelar" });

  assert.equal(getDraft("8"), undefined);
  assert.ok(messages.at(-1).text.includes("Cancelado"));
});

test("normal flow choose payment and confirm", async () => {
  __resetState();
  const { sendMessage, messages } = createMessageSpy();
  let saved = null;
  const handler = createMessageHandler({
    sendMessage,
    getActiveCardNamesFn: async () => ["BBVA Platino"]
  });

  const { answerCallback } = createAnswerSpy();
  const callbackHandler = createCallbackHandler({
    sendMessage,
    answerCallback,
    saveExpenseFn: async ({ draft }) => {
      saved = draft;
      return { ok: true, expenseId: "exp-1" };
    },
    getActiveCardNamesFn: async () => ["BBVA Platino"]
  });

  await handler({ chat: { id: 9 }, text: "230 pizza dominos ayer" });
  await callbackHandler({
    id: "cb3",
    data: "payment_method|BBVA Platino",
    message: { chat: { id: 9 } }
  });
  await callbackHandler({
    id: "cb4",
    data: "confirm",
    message: { chat: { id: 9 } }
  });

  assert.ok(saved);
  assert.equal(saved.payment_method, "BBVA Platino");
  assert.equal(saved.__state, "ready_to_confirm");
  assert.ok(messages.at(-1).text.includes("Confirmar gasto"));
});

test("msi flow months payment confirm", async () => {
  __resetState();
  const { sendMessage } = createMessageSpy();
  let saved = null;
  const handler = createMessageHandler({
    sendMessage,
    getActiveCardNamesFn: async () => ["BBVA Platino"]
  });

  const { answerCallback } = createAnswerSpy();
  const callbackHandler = createCallbackHandler({
    sendMessage,
    answerCallback,
    saveExpenseFn: async ({ draft }) => {
      saved = draft;
      return { ok: true, expenseId: "exp-2" };
    },
    getActiveCardNamesFn: async () => ["BBVA Platino"]
  });

  await handler({ chat: { id: 10 }, text: "amazon 6000 a msi" });
  await handler({ chat: { id: 10 }, text: "6" });
  await callbackHandler({
    id: "cb5",
    data: "payment_method|BBVA Platino",
    message: { chat: { id: 10 } }
  });
  await callbackHandler({
    id: "cb6",
    data: "confirm",
    message: { chat: { id: 10 } }
  });

  assert.ok(saved);
  assert.equal(saved.is_msi, true);
  assert.equal(saved.msi_months, 6);
  assert.equal(saved.payment_method, "BBVA Platino");
});

test("text while awaiting payment method", async () => {
  __resetState();
  const { sendMessage, messages } = createMessageSpy();
  const handler = createMessageHandler({
    sendMessage,
    getActiveCardNamesFn: async () => ["BBVA Platino"]
  });

  await handler({ chat: { id: 11 }, text: "100 uber ayer" });
  await handler({ chat: { id: 11 }, text: "otro texto" });

  assert.ok(messages.at(-1).text.includes("Elige un método"));
});

test("category mapping rules", () => {
  assert.equal(guessCategory("Uber viaje"), "Transport");
  assert.equal(guessCategory("La Comer super"), "Groceries");
  assert.equal(guessCategory("Spotify suscripcion"), "Subscriptions");
  assert.equal(guessCategory("Pemex gasolina"), "Gas");
  assert.equal(guessCategory("Palacio de Hierro compra"), "Clothing");
});

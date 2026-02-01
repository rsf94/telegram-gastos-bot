import test from "node:test";
import assert from "node:assert/strict";

import { createMessageHandler } from "../src/handlers/messages.js";
import { createCallbackHandler } from "../src/handlers/callbacks.js";
import { __resetState, getLedgerDraft } from "../src/state.js";

function createMessageSpy() {
  const messages = [];
  const sendMessage = async (chatId, text, extra) => {
    messages.push({ chatId, text, extra });
  };
  const editMessage = async (chatId, messageId, text, extra) => {
    messages.push({ chatId, messageId, text, extra, edited: true });
  };
  return { sendMessage, editMessage, messages };
}

function createAnswerSpy() {
  const calls = [];
  const answerCallback = async (id) => {
    calls.push(id);
  };
  return { answerCallback, calls };
}

function createLedgerStore() {
  const accounts = [];
  const movements = [];
  const listAccountsFn = async ({ chatId, activeOnly = true }) =>
    accounts.filter(
      (acc) => acc.chat_id === String(chatId) && (!activeOnly || acc.active)
    );

  const createAccountFn = async ({
    chatId,
    accountName,
    institution,
    accountType,
    currency = "MXN"
  }) => {
    const account = {
      account_id: `acc-${accounts.length + 1}`,
      chat_id: String(chatId),
      account_name: accountName,
      institution,
      account_type: accountType,
      currency,
      active: true
    };
    accounts.push(account);
    return account;
  };

  const insertLedgerMovementFn = async (draft, chatId) => {
    const movement = {
      movement_id: `mov-${movements.length + 1}`,
      chat_id: String(chatId),
      movement_type: draft.movement_type,
      from_account_id: draft.from_account_id,
      to_account_id: draft.to_account_id,
      amount_mxn: draft.amount_mxn
    };
    movements.push(movement);
    return movement.movement_id;
  };

  return { accounts, movements, listAccountsFn, createAccountFn, insertLedgerMovementFn };
}

test("create and list accounts", async () => {
  __resetState();
  const store = createLedgerStore();
  const { sendMessage, messages } = createMessageSpy();
  const handler = createMessageHandler({
    sendMessage,
    listAccountsFn: store.listAccountsFn,
    createAccountFn: store.createAccountFn
  });

  await handler({ chat: { id: 101 }, text: "/cuentas" });
  assert.equal(store.accounts.length, 1);
  assert.equal(store.accounts[0].account_type, "CASH");
  assert.ok(messages.at(-1).text.includes("Efectivo"));

  await handler({
    chat: { id: 101 },
    text: "/alta_cuenta Nómina BBVA | BBVA | DEBIT"
  });
  assert.equal(store.accounts.length, 2);
  assert.ok(messages.at(-1).text.includes("Cuenta creada"));

  await handler({ chat: { id: 101 }, text: "/cuentas" });
  assert.ok(messages.at(-1).text.includes("Nómina BBVA"));
});

test("withdrawal flow can be cancelled", async () => {
  __resetState();
  const store = createLedgerStore();
  await store.createAccountFn({
    chatId: "202",
    accountName: "Nómina BBVA",
    institution: "BBVA",
    accountType: "DEBIT"
  });
  await store.createAccountFn({
    chatId: "202",
    accountName: "Efectivo",
    institution: "Cash",
    accountType: "CASH"
  });
  const { sendMessage, messages } = createMessageSpy();
  const { answerCallback } = createAnswerSpy();
  const handler = createMessageHandler({
    sendMessage,
    listAccountsFn: store.listAccountsFn,
    createAccountFn: store.createAccountFn
  });
  const callbackHandler = createCallbackHandler({
    sendMessage,
    answerCallback,
    insertLedgerMovementFn: store.insertLedgerMovementFn
  });

  await handler({ chat: { id: 202 }, text: "/mov retiro 2000 bbva" });
  assert.ok(messages.at(-1).text.includes("Confirmar movimiento"));
  assert.ok(getLedgerDraft("202"));

  await callbackHandler({
    id: "cb-cancel",
    data: "ledger_cancel",
    message: { chat: { id: 202 } }
  });
  assert.equal(store.movements.length, 0);
});

test("deposit happy path", async () => {
  __resetState();
  const store = createLedgerStore();
  const debit = await store.createAccountFn({
    chatId: "303",
    accountName: "Nómina BBVA",
    institution: "BBVA",
    accountType: "DEBIT"
  });
  const { sendMessage } = createMessageSpy();
  const { answerCallback } = createAnswerSpy();
  const handler = createMessageHandler({
    sendMessage,
    listAccountsFn: store.listAccountsFn,
    createAccountFn: store.createAccountFn
  });
  const callbackHandler = createCallbackHandler({
    sendMessage,
    answerCallback,
    insertLedgerMovementFn: store.insertLedgerMovementFn
  });

  await handler({ chat: { id: 303 }, text: "/mov deposito 3000 bbva" });
  await callbackHandler({
    id: "cb-deposit",
    data: "ledger_confirm",
    message: { chat: { id: 303 } }
  });

  assert.equal(store.movements.length, 1);
  assert.equal(store.movements[0].movement_type, "DEPOSIT");
  assert.equal(store.movements[0].to_account_id, debit.account_id);
});

test("transfer happy path", async () => {
  __resetState();
  const store = createLedgerStore();
  const from = await store.createAccountFn({
    chatId: "404",
    accountName: "BBVA Nómina",
    institution: "BBVA",
    accountType: "DEBIT"
  });
  const to = await store.createAccountFn({
    chatId: "404",
    accountName: "Banorte Platino",
    institution: "Banorte",
    accountType: "DEBIT"
  });
  const { sendMessage } = createMessageSpy();
  const { answerCallback } = createAnswerSpy();
  const handler = createMessageHandler({
    sendMessage,
    listAccountsFn: store.listAccountsFn,
    createAccountFn: store.createAccountFn
  });
  const callbackHandler = createCallbackHandler({
    sendMessage,
    answerCallback,
    insertLedgerMovementFn: store.insertLedgerMovementFn
  });

  await handler({ chat: { id: 404 }, text: "/mov transfer 5000 bbva -> banorte" });
  await callbackHandler({
    id: "cb-transfer",
    data: "ledger_confirm",
    message: { chat: { id: 404 } }
  });

  assert.equal(store.movements.length, 1);
  assert.equal(store.movements[0].movement_type, "TRANSFER");
  assert.equal(store.movements[0].from_account_id, from.account_id);
  assert.equal(store.movements[0].to_account_id, to.account_id);
});

test("ambiguous account selection prompts for choice", async () => {
  __resetState();
  const store = createLedgerStore();
  await store.createAccountFn({
    chatId: "505",
    accountName: "BBVA Nómina",
    institution: "BBVA",
    accountType: "DEBIT"
  });
  await store.createAccountFn({
    chatId: "505",
    accountName: "BBVA Ahorro",
    institution: "BBVA",
    accountType: "DEBIT"
  });
  const { sendMessage, messages } = createMessageSpy();
  const { answerCallback } = createAnswerSpy();
  const handler = createMessageHandler({
    sendMessage,
    listAccountsFn: store.listAccountsFn,
    createAccountFn: store.createAccountFn
  });
  const callbackHandler = createCallbackHandler({
    sendMessage,
    answerCallback,
    insertLedgerMovementFn: store.insertLedgerMovementFn
  });

  await handler({ chat: { id: 505 }, text: "/mov retiro 1000 bbva" });
  const selectionMessage = messages.at(-1);
  assert.ok(selectionMessage.text.includes("Selecciona la cuenta"));
  assert.ok(selectionMessage.extra.reply_markup.inline_keyboard.length > 1);

  const selectedId = store.accounts[0].account_id;
  await callbackHandler({
    id: "cb-select",
    data: `ledger_select|from|${selectedId}`,
    message: { chat: { id: 505 } }
  });
  assert.ok(messages.at(-1).text.includes("Confirmar movimiento"));
});

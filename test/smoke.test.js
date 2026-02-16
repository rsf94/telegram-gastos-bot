import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createMessageHandler } from "../src/handlers/messages.js";
import { createCallbackHandler } from "../src/handlers/callbacks.js";
import { saveExpense } from "../src/usecases/save_expense.js";
import { deleteExpense } from "../src/usecases/delete_expense.js";
import {
  processEnrichmentRetryQueue,
  runEnrichmentUpdateWithRetry
} from "../src/usecases/enrichment_retry.js";
import {
  buildLatestEnrichmentRetryQuery,
  insertPendingUserLink,
  __setUserLinksTableForTests
} from "../src/storage/bigquery.js";
import { getDraft, getPendingDelete, __resetState } from "../src/state.js";
import { guessCategory } from "../src/parsing.js";
import { __resetConfirmIdempotency } from "../src/cache/confirm_idempotency.js";
import { helpText, welcomeText } from "../src/ui/copy.js";
import {
  __resetCardRulesCache,
  __setFetchActiveRules,
  getCardRule,
  getActiveCardNames
} from "../src/cache/card_rules_cache.js";
import { createLinkToken } from "../src/linking.js";

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function withEnv(vars, fn) {
  const prev = {};
  for (const [key, value] of Object.entries(vars)) {
    prev[key] = Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : undefined;
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  const restore = () => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
  const result = fn();
  if (result && typeof result.finally === "function") {
    return result.finally(restore);
  }
  restore();
  return result;
}

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
  assert.ok(messages.at(-1).text.includes("Elige método de pago"));
});

test("hola returns welcome copy", async () => {
  __resetState();
  const { sendMessage, messages } = createMessageSpy();
  const handler = createMessageHandler({ sendMessage });

  await handler({ chat: { id: 10 }, text: "hola" });

  assert.equal(messages.at(-1).text, welcomeText());
  assert.ok(messages.at(-1).text.includes("Mándame un gasto"));
});

test("ayuda returns help copy", async () => {
  __resetState();
  const { sendMessage, messages } = createMessageSpy();
  const handler = createMessageHandler({ sendMessage });

  await handler({ chat: { id: 11 }, text: "ayuda" });

  assert.equal(messages.at(-1).text, helpText());
  assert.ok(messages.at(-1).text.includes("/analisis"));
  assert.ok(messages.at(-1).text.includes("/borrar"));
});

test("/link returns link URL and signed token", async () => {
  await withEnv(
    { DASHBOARD_BASE_URL: "https://corte-web.example", LINK_TOKEN_SECRET: "secret" },
    async () => {
      __resetState();
      const { sendMessage, messages } = createMessageSpy();
      const handler = createMessageHandler({ sendMessage });

      await handler({ chat: { id: 99 }, text: "/link" });

      const reply = messages.at(-1).text;
      assert.ok(reply.includes("/link?token="));
      assert.ok(!reply.includes(welcomeText()));
    }
  );
});

test("/link token verifies and includes payload", async () => {
  await withEnv(
    { DASHBOARD_BASE_URL: "https://corte-web.example", LINK_TOKEN_SECRET: "secret2" },
    async () => {
      __resetState();
      const { sendMessage, messages } = createMessageSpy();
      const handler = createMessageHandler({ sendMessage });

      await handler({ chat: { id: 42 }, text: "/link@" });

      const reply = messages.at(-1).text;
      const tokenMatch = reply.match(/token=([A-Za-z0-9._-]+)/);
      assert.ok(tokenMatch);
      const token = tokenMatch[1];
      const [header, payload, signature] = token.split(".");
      assert.ok(header && payload && signature);

      const unsigned = `${header}.${payload}`;
      const expectedSignature = crypto
        .createHmac("sha256", "secret2")
        .update(unsigned)
        .digest("base64")
        .replace(/=+$/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
      assert.equal(signature, expectedSignature);

      const payloadJson = JSON.parse(base64UrlDecode(payload));
      assert.equal(payloadJson.chat_id, "42");
      assert.ok(payloadJson.iat);
      assert.ok(payloadJson.exp);
      assert.ok(payloadJson.nonce);
      assert.equal(payloadJson.exp - payloadJson.iat, 10 * 60);
    }
  );
});

test("/dashboard returns dashboard URL", async () => {
  await withEnv(
    {
      DASHBOARD_BASE_URL: "https://corte-web.example",
      LINK_TOKEN_SECRET: "dash-secret"
    },
    async () => {
      __resetState();
      const { sendMessage, messages } = createMessageSpy();
      const inserts = [];
      const handler = createMessageHandler({
        sendMessage,
        insertPendingUserLinkFn: async (payload) => {
          inserts.push(payload);
        }
      });

      await handler({ chat: { id: 77 }, text: "/dashboard" });

      const reply = messages.at(-1).text;
      assert.ok(reply.includes("/dashboard?link_token="));
      assert.ok(reply.includes("Expira en 15 min"));
      assert.equal(inserts.length, 1);
      assert.equal(inserts[0].chatId, "77");
      assert.ok(inserts[0].linkToken);
      assert.ok(inserts[0].expiresAt instanceof Date);
      assert.ok(!reply.includes(welcomeText()));
    }
  );
});

test("createLinkToken returns expected format and ttl", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const { linkToken, expiresAt } = createLinkToken({
    secret: "token-secret",
    now
  });

  assert.match(linkToken, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const [randomPart, signature] = linkToken.split(".");
  assert.equal(randomPart.length, 32);
  assert.equal(signature.length, 43);
  assert.equal(expiresAt.toISOString(), "2026-01-01T00:15:00.000Z");
});

test("/dashboard insert receives required BigQuery fields", async () => {
  await withEnv(
    {
      DASHBOARD_BASE_URL: "https://corte-web.example",
      LINK_TOKEN_SECRET: "dash-secret"
    },
    async () => {
      __resetState();
      const { sendMessage } = createMessageSpy();
      const inserts = [];
      const handler = createMessageHandler({
        sendMessage,
        insertPendingUserLinkFn: async (payload) => {
          inserts.push(payload);
        }
      });

      await handler({ chat: { id: 701 }, text: "/dashboard" });

      assert.equal(inserts.length, 1);
      assert.deepEqual(Object.keys(inserts[0]).sort(), [
        "chatId",
        "createdAt",
        "expiresAt",
        "linkToken",
        "requestId"
      ]);
      assert.equal(inserts[0].chatId, "701");
      assert.equal(inserts[0].createdAt instanceof Date, true);
      assert.equal(inserts[0].expiresAt instanceof Date, true);
      assert.match(inserts[0].linkToken, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    }
  );
});

test("insertPendingUserLink logs bq_insert_error for partial failures without leaking token", async () => {
  const capturedErrors = [];
  const originalError = console.error;
  const linkToken = "abcdef123456.SECRET_SUFFIX";

  __setUserLinksTableForTests({
    insert: async () => {
      const error = new Error("partial failure");
      error.name = "PartialFailureError";
      error.errors = [
        { errors: [{ reason: "invalid", message: "bad metadata", location: "metadata" }] }
      ];
      error.response = {
        insertErrors: [
          { index: 0, errors: [{ reason: "invalid", message: "metadata invalid", location: "metadata" }] }
        ]
      };
      throw error;
    }
  });

  console.error = (...args) => {
    capturedErrors.push(args.join(" "));
  };

  try {
    await assert.rejects(
      insertPendingUserLink({
        linkToken,
        chatId: 123,
        expiresAt: new Date("2026-01-01T00:15:00.000Z"),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        requestId: "req-1"
      }),
      /partial failure/
    );
  } finally {
    console.error = originalError;
    __setUserLinksTableForTests(null);
  }

  const logLine = capturedErrors.find((line) => line.includes('"type":"bq_insert_error"'));
  assert.ok(logLine);
  assert.ok(logLine.includes('"errors":'));
  assert.ok(!logLine.includes(linkToken));
  assert.ok(/"link_token_preview":\{"prefix":"abcdef","length":\d+\}/.test(logLine));
});

test("insertPendingUserLink sends snake_case payload and string chat_id", async () => {
  const rows = [];
  __setUserLinksTableForTests({
    insert: async (payload) => {
      rows.push(...payload);
    }
  });

  try {
    await insertPendingUserLink({
      linkToken: "abc.def",
      chatId: 456,
      expiresAt: new Date("2026-01-01T00:15:00.000Z"),
      createdAt: new Date("2026-01-01T00:00:00.000Z")
    });
  } finally {
    __setUserLinksTableForTests(null);
  }

  assert.equal(rows.length, 1);
  assert.equal(rows[0].link_token, "abc.def");
  assert.equal(rows[0].chat_id, "456");
  assert.equal(rows[0].created_at, "2026-01-01T00:00:00.000Z");
  assert.equal(rows[0].expires_at, "2026-01-01T00:15:00.000Z");
  assert.equal(rows[0].metadata, JSON.stringify({ telegram_chat_id: "456" }));
  assert.ok(!("linkToken" in rows[0]));
});

test("/dashboard insert failure replies clear error", async () => {
  await withEnv(
    {
      DASHBOARD_BASE_URL: "https://corte-web.example",
      LINK_TOKEN_SECRET: "dash-secret"
    },
    async () => {
      __resetState();
      const { sendMessage, messages } = createMessageSpy();
      const handler = createMessageHandler({
        sendMessage,
        insertPendingUserLinkFn: async () => {
          throw new Error("PartialFailureError");
        }
      });

      await handler({ chat: { id: 79 }, text: "/dashboard" }, { requestId: "req-79" });

      assert.ok(messages.at(-1).text.includes("No pude preparar tu acceso al dashboard"));
    }
  );
});

test("/dashboard warns when env vars are missing", async () => {
  await withEnv({ DASHBOARD_BASE_URL: undefined, LINK_TOKEN_SECRET: undefined }, async () => {
    __resetState();
    const { sendMessage, messages } = createMessageSpy();
    const handler = createMessageHandler({ sendMessage });

    await handler({ chat: { id: 78 }, text: "/dashboard@" });

    assert.equal(
      messages.at(-1).text,
      "⚠️ No está configurado el dashboard/linking (faltan variables de entorno)."
    );
  });
});

test("msi step1 asks for payment method even without months", async () => {
  __resetState();
  const { sendMessage, messages } = createMessageSpy();
  const handler = createMessageHandler({
    sendMessage,
    getActiveCardNamesFn: async () => []
  });

  await handler({ chat: { id: 2 }, text: "gasolina 1200 BBVA Platino a MSI" });

  const draft = getDraft("2");
  assert.equal(draft.__state, "awaiting_payment_method");
  assert.ok(messages.at(-1).text.includes("Elige método de pago"));
});

test("msi explicit months skips months question", async () => {
  __resetState();
  const { sendMessage, editMessage, messages } = createMessageSpy();
  const handler = createMessageHandler({
    sendMessage,
    getActiveCardNamesFn: async () => ["BBVA Platino"]
  });
  const { answerCallback } = createAnswerSpy();
  const callbackHandler = createCallbackHandler({
    sendMessage,
    editMessage,
    answerCallback,
    getActiveCardNamesFn: async () => ["BBVA Platino"],
    getBillingMonthForPurchaseFn: async () => "2026-02-01"
  });

  await handler({ chat: { id: 12 }, text: "amazon 6000 6msi" });

  const draft = getDraft("12");
  assert.equal(draft.__state, "awaiting_payment_method");
  assert.ok(messages.at(-1).text.includes("Elige método de pago"));

  await callbackHandler({
    id: "cb12",
    data: "payment_method|BBVA Platino",
    message: { chat: { id: 12 }, message_id: 12 }
  });
  const updated = getDraft("12");
  assert.equal(updated.msi_start_month, "2026-02-01");
});

test("msi step2 stores months, monthly amount, and billing start month", async () => {
  __resetState();
  const { sendMessage, editMessage, messages } = createMessageSpy();
  const handler = createMessageHandler({
    sendMessage,
    getActiveCardNamesFn: async () => ["BBVA Platino"],
    getBillingMonthForPurchaseFn: async () => "2026-02-01"
  });
  const { answerCallback } = createAnswerSpy();
  const callbackHandler = createCallbackHandler({
    sendMessage,
    editMessage,
    answerCallback,
    getActiveCardNamesFn: async () => ["BBVA Platino"],
    getBillingMonthForPurchaseFn: async () => "2026-02-01"
  });

  await handler({ chat: { id: 3 }, text: "gasolina 1200 BBVA Platino a MSI" });
  await callbackHandler({
    id: "cb3b",
    data: "payment_method|BBVA Platino",
    message: { chat: { id: 3 }, message_id: 33 }
  });
  await handler({ chat: { id: 3 }, text: "6" });

  const draft = getDraft("3");
  assert.equal(draft.msi_months, 6);
  assert.equal(draft.amount_mxn, 200);
  assert.equal(draft.msi_start_month, "2026-02-01");
  assert.equal(draft.__state, "ready_to_confirm");
  assert.ok(messages.at(-1).text.includes("Confirmar gasto"));
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
  const { sendMessage, editMessage, messages } = createMessageSpy();
  let saved = null;
  const handler = createMessageHandler({
    sendMessage,
    getActiveCardNamesFn: async () => ["BBVA Platino"]
  });

  const saveExpenseFn = async ({ chatId, draft }) => {
    const result = await saveExpense({
      chatId,
      draft,
      sendMessage,
      insertExpense: async () => "exp-1",
      updateExpenseEnrichmentFn: async () => {},
      enrichExpenseLLMFn: async ({ baseDraft }) => ({
        llm_provider: "local",
        category: baseDraft.category,
        merchant: baseDraft.merchant,
        description: baseDraft.description
      }),
      llmProviderEnv: "local",
      resolveActiveTripForChatFn: async () => null
    });
    saved = draft;
    return result;
  };

  const { answerCallback } = createAnswerSpy();
  const callbackHandler = createCallbackHandler({
    sendMessage,
    editMessage,
    answerCallback,
    saveExpenseFn,
    getActiveCardNamesFn: async () => ["BBVA Platino"]
  });

  await handler({ chat: { id: 9 }, text: "230 pizza dominos ayer" });
  await callbackHandler({
    id: "cb3",
    data: "payment_method|BBVA Platino",
    message: { chat: { id: 9 }, message_id: 44 }
  });
  await callbackHandler({
    id: "cb4",
    data: "confirm",
    message: { chat: { id: 9 } }
  });

  assert.ok(saved);
  assert.equal(saved.payment_method, "BBVA Platino");
  assert.equal(saved.__state, "ready_to_confirm");
  assert.ok(messages.some((msg) => msg.text.includes("Confirmar gasto")));
  assert.ok(messages.some((msg) => msg.text.includes("ID: <code>exp-1</code>")));
});

test("msi flow months payment confirm", async () => {
  __resetState();
  const { sendMessage, editMessage, messages } = createMessageSpy();
  let saved = null;
  const handler = createMessageHandler({
    sendMessage,
    getActiveCardNamesFn: async () => ["BBVA Platino"],
    getBillingMonthForPurchaseFn: async () => "2026-02-01"
  });

  const saveExpenseFn = async ({ chatId, draft }) => {
    const result = await saveExpense({
      chatId,
      draft,
      sendMessage,
      insertExpense: async () => "exp-2",
      updateExpenseEnrichmentFn: async () => {},
      enrichExpenseLLMFn: async ({ baseDraft }) => ({
        llm_provider: "local",
        category: baseDraft.category,
        merchant: baseDraft.merchant,
        description: baseDraft.description
      }),
      llmProviderEnv: "local",
      resolveActiveTripForChatFn: async () => null
    });
    saved = draft;
    return result;
  };

  const { answerCallback } = createAnswerSpy();
  const callbackHandler = createCallbackHandler({
    sendMessage,
    editMessage,
    answerCallback,
    saveExpenseFn,
    getActiveCardNamesFn: async () => ["BBVA Platino"],
    getBillingMonthForPurchaseFn: async () => "2026-02-01"
  });

  await handler({ chat: { id: 10 }, text: "amazon 6000 a msi" });
  await callbackHandler({
    id: "cb5",
    data: "payment_method|BBVA Platino",
    message: { chat: { id: 10 }, message_id: 55 }
  });
  await handler({ chat: { id: 10 }, text: "6" });
  await callbackHandler({
    id: "cb6",
    data: "confirm",
    message: { chat: { id: 10 } }
  });

  assert.ok(saved);
  assert.equal(saved.is_msi, true);
  assert.equal(saved.msi_months, 6);
  assert.equal(saved.payment_method, "BBVA Platino");
  assert.equal(saved.msi_start_month, "2026-02-01");
  assert.ok(messages.some((msg) => msg.text.includes("ID: <code>exp-2</code>")));
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

test("msi step2 does not call saveExpense", async () => {
  __resetState();
  const { sendMessage, editMessage } = createMessageSpy();
  let saveCalls = 0;

  const handler = createMessageHandler({
    sendMessage,
    saveExpenseFn: async () => {
      saveCalls += 1;
      return { ok: true, expenseId: "exp-msi" };
    },
    getActiveCardNamesFn: async () => ["BBVA Platino"],
    getBillingMonthForPurchaseFn: async () => "2026-02-01"
  });

  const { answerCallback } = createAnswerSpy();
  const callbackHandler = createCallbackHandler({
    sendMessage,
    editMessage,
    answerCallback,
    getActiveCardNamesFn: async () => ["BBVA Platino"]
  });

  await handler({ chat: { id: 13 }, text: "gasolina 1200 BBVA Platino a MSI" });
  await callbackHandler({
    id: "cb13",
    data: "payment_method|BBVA Platino",
    message: { chat: { id: 13 }, message_id: 13 }
  });
  await handler({ chat: { id: 13 }, text: "6" });

  assert.equal(saveCalls, 0);
});

test("confirm idempotency prevents duplicate inserts", async () => {
  __resetConfirmIdempotency();
  const { sendMessage, messages } = createMessageSpy();
  let insertCount = 0;

  const draft = {
    raw_text: "pizza 100",
    purchase_date: "2024-01-01",
    payment_method: "BBVA Platino",
    amount_mxn: 100,
    category: "Other",
    merchant: "",
    description: "Test",
    is_msi: false,
    msi_months: null,
    msi_total_amount: null,
    __perf: { parse_ms: 5, cache_hit: { card_rules: true, llm: null } }
  };

  const insertExpense = async () => {
    insertCount += 1;
    return "exp-1";
  };

  await saveExpense({
    chatId: "20",
    draft,
    sendMessage,
    insertExpense,
    updateExpenseEnrichmentFn: async () => {},
    enrichExpenseLLMFn: async ({ baseDraft }) => ({
      llm_provider: "local",
      category: baseDraft.category,
      merchant: baseDraft.merchant,
      description: baseDraft.description,
      cache_hit: false
    }),
    llmProviderEnv: "local",
    resolveActiveTripForChatFn: async () => null
  });

  await saveExpense({
    chatId: "20",
    draft,
    sendMessage,
    insertExpense,
    updateExpenseEnrichmentFn: async () => {},
    enrichExpenseLLMFn: async () => {
      throw new Error("LLM should not be called");
    },
    llmProviderEnv: "local",
    resolveActiveTripForChatFn: async () => null
  });

  assert.equal(insertCount, 1);
  assert.ok(messages.some((msg) => msg.text.includes("Ya estaba guardado")));
});

test("delete removes installments and expense", async () => {
  const { sendMessage, messages } = createMessageSpy();
  const result = await deleteExpense({
    chatId: "30",
    pendingDelete: { expenseId: "exp-30" },
    deleteExpenseFn: async () => ({
      deletedInstallments: 3,
      deletedExpense: 1
    }),
    sendMessage
  });

  assert.equal(result.ok, true);
  assert.ok(messages.at(-1).text.includes("Installments eliminados: 3"));
});

test("card rules cache avoids repeated fetches", async () => {
  __resetCardRulesCache();
  let fetchCount = 0;
  __setFetchActiveRules(async () => {
    fetchCount += 1;
    return [
      {
        chat_id: "40",
        card_name: "BBVA Platino",
        cut_day: 5,
        billing_shift_months: 0
      }
    ];
  });

  await getCardRule("40", "BBVA Platino");
  await getActiveCardNames("40");
  await getCardRule("40", "BBVA Platino");

  assert.equal(fetchCount, 1);
});

test("enrichment retry enqueues after streaming buffer error", async () => {
  let updateCalls = 0;
  let enqueuePayload = null;

  const updateExpenseEnrichmentFn = async () => {
    updateCalls += 1;
    throw new Error("would affect rows in the streaming buffer");
  };

  const enqueueEnrichmentRetryFn = async (payload) => {
    enqueuePayload = payload;
  };

  const result = await runEnrichmentUpdateWithRetry({
    chatId: "50",
    expenseId: "exp-50",
    category: "Transport",
    merchant: "Uber",
    description: "Ride",
    updateExpenseEnrichmentFn,
    enqueueEnrichmentRetryFn,
    backoffMs: [0, 0, 0, 0],
    sleepFn: async () => {}
  });

  assert.equal(result.ok, false);
  assert.equal(updateCalls, 5);
  assert.equal(enqueuePayload.expenseId, "exp-50");
  assert.equal(enqueuePayload.chatId, "50");
});

test("enrichment retry query uses latest state window", async () => {
  const query = buildLatestEnrichmentRetryQuery({ limit: 25 });
  assert.ok(query.includes("QUALIFY ROW_NUMBER()"));
  assert.ok(query.includes("PARTITION BY expense_id"));
});

test("enrichment cron records success events", async () => {
  const inserts = [];
  const tasks = [
    {
      expense_id: "exp-60",
      chat_id: "60",
      category: "Other",
      merchant: null,
      description: null,
      attempts: 0
    }
  ];

  const getDueEnrichmentRetryTasksFn = async () => tasks;
  const updateExpenseEnrichmentFn = async () => {};
  const getExpenseByIdFn = async () => ({
    id: "exp-60",
    raw_text: "Uber 123",
    amount_mxn: "123",
    payment_method: "BBVA",
    purchase_date: "2024-01-01"
  });
  const enrichExpenseLLMFn = async () => ({
    category: "Transport",
    merchant: "Uber",
    description: "Ride",
    llm_provider: "gemini"
  });
  const insertEnrichmentRetryEventFn = async (payload) => {
    inserts.push(payload);
  };

  const result = await processEnrichmentRetryQueue({
    limit: 1,
    getDueEnrichmentRetryTasksFn,
    getExpenseByIdFn,
    enrichExpenseLLMFn,
    updateExpenseEnrichmentFn,
    insertEnrichmentRetryEventFn
  });

  assert.equal(result.processed, 1);
  assert.equal(result.done, 1);
  assert.ok(inserts.some((row) => row.status === "RUNNING"));
  assert.ok(inserts.some((row) => row.status === "SUCCEEDED"));
});

test("enrichment cron handles streaming buffer errors without throwing", async () => {
  const inserts = [];
  const tasks = [
    {
      expense_id: "exp-70",
      chat_id: "70",
      attempts: 1
    }
  ];

  const getDueEnrichmentRetryTasksFn = async () => tasks;
  const getExpenseByIdFn = async () => ({
    id: "exp-70",
    raw_text: "Comida 200",
    amount_mxn: "200",
    payment_method: "BBVA",
    purchase_date: "2024-01-01"
  });
  const enrichExpenseLLMFn = async () => ({
    category: "Food",
    merchant: "Tacos",
    description: "Cena",
    llm_provider: "gemini"
  });
  const updateExpenseEnrichmentFn = async () => {
    throw new Error("would affect rows in the streaming buffer");
  };
  const insertEnrichmentRetryEventFn = async (payload) => {
    inserts.push(payload);
  };

  const result = await processEnrichmentRetryQueue({
    limit: 1,
    getDueEnrichmentRetryTasksFn,
    getExpenseByIdFn,
    enrichExpenseLLMFn,
    updateExpenseEnrichmentFn,
    insertEnrichmentRetryEventFn
  });

  assert.equal(result.processed, 1);
  assert.equal(result.failed, 1);
  assert.ok(inserts.some((row) => row.status === "FAILED"));
});

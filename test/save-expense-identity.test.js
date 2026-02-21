import test from "node:test";
import assert from "node:assert/strict";

import { saveExpense } from "../src/usecases/save_expense.js";
import { __resetConfirmIdempotency } from "../src/cache/confirm_idempotency.js";

function createSendMessageStub() {
  return async () => {};
}

function buildDraft(overrides = {}) {
  return {
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
    __perf: { parse_ms: 1, cache_hit: { card_rules: true, llm: null } },
    ...overrides
  };
}

const enrichExpenseLLMFn = async ({ baseDraft }) => ({
  llm_provider: "local",
  category: baseDraft.category,
  merchant: baseDraft.merchant,
  description: baseDraft.description,
  cache_hit: false
});

test("saveExpense inserta user_id cuando existe link", async () => {
  __resetConfirmIdempotency();
  const insertDrafts = [];

  await saveExpense({
    chatId: "9001",
    draft: buildDraft(),
    sendMessage: createSendMessageStub(),
    resolveUserIdByChatIdFn: async () => "user-9001",
    insertExpense: async (insertDraft) => {
      insertDrafts.push(insertDraft);
      return "expense-1";
    },
    updateExpenseEnrichmentFn: async () => {},
    enrichExpenseLLMFn,
    llmProviderEnv: "local"
  });

  assert.equal(insertDrafts.length, 1);
  assert.equal(insertDrafts[0].user_id, "user-9001");
});

test("saveExpense inserta user_id null cuando no existe link", async () => {
  __resetConfirmIdempotency();
  const insertDrafts = [];

  await saveExpense({
    chatId: "9002",
    draft: buildDraft({ raw_text: "comida 120", amount_mxn: 120 }),
    sendMessage: createSendMessageStub(),
    resolveUserIdByChatIdFn: async () => null,
    insertExpense: async (insertDraft) => {
      insertDrafts.push(insertDraft);
      return "expense-2";
    },
    updateExpenseEnrichmentFn: async () => {},
    enrichExpenseLLMFn,
    llmProviderEnv: "local"
  });

  assert.equal(insertDrafts.length, 1);
  assert.equal(insertDrafts[0].user_id, null);
});

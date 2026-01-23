import test from "node:test";
import assert from "node:assert/strict";

import { buildCutAndPayDates, statementMonthISO } from "../src/analysis/date_utils.js";
import { createAnalysisHandler } from "../src/handlers/analysis.js";

test("buildCutAndPayDates for BBVA", () => {
  const { cutISO, payISO } = buildCutAndPayDates({
    year: 2024,
    month: 5,
    cutDay: 2,
    payOffsetDays: 20,
    rollWeekendToMonday: false
  });

  assert.equal(cutISO, "2024-05-02");
  assert.equal(payISO, "2024-05-22");
  assert.equal(statementMonthISO(cutISO), "2024-05-01");
});

test("buildCutAndPayDates for Banorte", () => {
  const { cutISO, payISO } = buildCutAndPayDates({
    year: 2024,
    month: 5,
    cutDay: 24,
    payOffsetDays: 20,
    rollWeekendToMonday: false
  });

  assert.equal(cutISO, "2024-05-24");
  assert.equal(payISO, "2024-06-13");
  assert.equal(statementMonthISO(cutISO), "2024-05-01");
});

test("buildCutAndPayDates for Amex", () => {
  const { cutISO, payISO } = buildCutAndPayDates({
    year: 2024,
    month: 5,
    cutDay: 11,
    payOffsetDays: 18,
    rollWeekendToMonday: false
  });

  assert.equal(cutISO, "2024-05-11");
  assert.equal(payISO, "2024-05-29");
  assert.equal(statementMonthISO(cutISO), "2024-05-01");
});

test("analysis pending MSI handles null billing_month", async () => {
  const messages = [];
  const handler = createAnalysisHandler({
    sendMessage: async (chatId, text) => {
      messages.push({ chatId, text });
    },
    editMessage: async () => {},
    answerCallback: async () => {},
    getAnalysisPendingMsiTotalFn: async () => 1200,
    getAnalysisPendingMsiByCardFn: async () => [],
    getAnalysisPendingMsiByMonthFn: async () => [{ billing_month: null, total: 500 }]
  });

  const callback = {
    id: "cb-1",
    data: "ANALYSIS:MSI_PENDING",
    message: { chat: { id: 123 }, message_id: 1 }
  };

  await assert.doesNotReject(() => handler.handleAnalysisCallback(callback));
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /Total pendiente MSI/);
  assert.match(messages[0].text, /Mes desconocido/);
});

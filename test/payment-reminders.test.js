import test from "node:test";
import assert from "node:assert/strict";

import {
  getNextPayDateISO,
  isPayDateTomorrow,
  runPaymentDateReminders
} from "../src/reminders.js";

test("pay date uses BBVA cut day and pay offset and detects tomorrow", async () => {
  const todayISO = "2026-01-21";
  const nextPayISO = getNextPayDateISO({
    todayISO,
    cutDay: 2,
    payOffsetDays: 20,
    rollWeekendToMonday: false
  });

  assert.equal(nextPayISO, "2026-01-22");

  const dueTomorrow = isPayDateTomorrow({
    todayISO,
    cutDay: 2,
    payOffsetDays: 20,
    rollWeekendToMonday: false
  });

  assert.equal(dueTomorrow, true);
});

test("pay date rolls weekend to Monday", async () => {
  const nextPayISO = getNextPayDateISO({
    todayISO: "2024-05-31",
    cutDay: 1,
    payOffsetDays: 0,
    rollWeekendToMonday: true
  });

  assert.equal(nextPayISO, "2024-06-03");

  const dueTomorrow = isPayDateTomorrow({
    todayISO: "2024-06-02",
    cutDay: 1,
    payOffsetDays: 0,
    rollWeekendToMonday: true
  });

  assert.equal(dueTomorrow, true);
});

test("payment reminder cron selects due cards and sends one message", async () => {
  const rules = [
    {
      chat_id: "1",
      card_name: "BBVA Platino",
      cut_day: 2,
      pay_offset_days: 20,
      roll_weekend_to_monday: false,
      active: true
    },
    {
      chat_id: "2",
      card_name: "Banorte",
      cut_day: 5,
      pay_offset_days: 10,
      roll_weekend_to_monday: false,
      active: true
    }
  ];

  const sent = [];
  const totals = [];

  const summary = await runPaymentDateReminders({
    todayISO: "2026-01-21",
    limitChats: 50,
    getActiveCardRulesFn: async () => rules,
    getCardCashflowTotalFn: async ({ chatId, cardName, monthISO }) => {
      totals.push({ chatId, cardName, monthISO });
      return 1234.56;
    },
    sendMessageFn: async (chatId, text) => {
      sent.push({ chatId, text });
    }
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.scanned_cards, 2);
  assert.equal(summary.due_tomorrow, 1);
  assert.equal(summary.sent, 1);
  assert.equal(summary.skipped, 0);

  assert.equal(totals.length, 1);
  assert.equal(totals[0].monthISO, "2026-01-01");

  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, "1");
  assert.match(sent[0].text, /BBVA Platino/);
  assert.match(sent[0].text, /Total estimado/);
});

import test from "node:test";
import assert from "node:assert/strict";

const rules = new Map();

function setRule({ chatId, cardName, cutDay, payOffsetDays, rollWeekendToMonday }) {
  rules.set(`${chatId}|${cardName}`, {
    cut_day: cutDay,
    pay_offset_days: payOffsetDays,
    roll_weekend_to_monday: rollWeekendToMonday,
    billing_shift_months: 0
  });
}

const getCardRuleFn = async (chatId, cardName) => {
  const rule = rules.get(`${chatId}|${cardName}`) || null;
  return { rule, cacheHit: true };
};

const { getBillingMonthForPurchase } = await import("../src/storage/bigquery.js");

test("cashflow month uses BBVA cut day and pay offset (after cut)", async () => {
  setRule({
    chatId: "1",
    cardName: "BBVA Platino",
    cutDay: 2,
    payOffsetDays: 20,
    rollWeekendToMonday: false
  });
  const billingMonth = await getBillingMonthForPurchase({
    chatId: "1",
    cardName: "BBVA Platino",
    purchaseDateISO: "2026-01-19",
    getCardRuleFn
  });
  assert.equal(billingMonth, "2026-02-01");
});

test("cashflow month uses Banorte cut day and pay offset", async () => {
  setRule({
    chatId: "2",
    cardName: "Banorte Platino",
    cutDay: 24,
    payOffsetDays: 20,
    rollWeekendToMonday: false
  });
  const billingMonth = await getBillingMonthForPurchase({
    chatId: "2",
    cardName: "Banorte Platino",
    purchaseDateISO: "2026-01-03",
    getCardRuleFn
  });
  assert.equal(billingMonth, "2026-02-01");
});

test("cashflow month keeps the same cut date when purchase is on cut day", async () => {
  setRule({
    chatId: "3",
    cardName: "Santander",
    cutDay: 10,
    payOffsetDays: 5,
    rollWeekendToMonday: false
  });
  const billingMonth = await getBillingMonthForPurchase({
    chatId: "3",
    cardName: "Santander",
    purchaseDateISO: "2026-03-10",
    getCardRuleFn
  });
  assert.equal(billingMonth, "2026-03-01");
});

test("cashflow month rolls weekend pay date to monday", async () => {
  setRule({
    chatId: "4",
    cardName: "Klar",
    cutDay: 31,
    payOffsetDays: 0,
    rollWeekendToMonday: true
  });
  const billingMonth = await getBillingMonthForPurchase({
    chatId: "4",
    cardName: "Klar",
    purchaseDateISO: "2026-01-10",
    getCardRuleFn
  });
  assert.equal(billingMonth, "2026-02-01");
});

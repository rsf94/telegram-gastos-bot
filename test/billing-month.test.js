import test from "node:test";
import assert from "node:assert/strict";

const rules = new Map();

function setRule({ chatId, cardName, cutDay, shift }) {
  rules.set(`${chatId}|${cardName}`, {
    cut_day: cutDay,
    billing_shift_months: shift
  });
}

const getCardRuleFn = async (chatId, cardName) => {
  const rule = rules.get(`${chatId}|${cardName}`) || null;
  return { rule, cacheHit: true };
};

const { getBillingMonthForPurchase } = await import("../src/storage/bigquery.js");

test("billing month respects cut_day BBVA (after cut)", async () => {
  setRule({ chatId: "1", cardName: "BBVA Platino", cutDay: 2, shift: 0 });
  const billingMonth = await getBillingMonthForPurchase({
    chatId: "1",
    cardName: "BBVA Platino",
    purchaseDateISO: "2026-01-19",
    getCardRuleFn
  });
  assert.equal(billingMonth, "2026-02-01");
});

test("billing month respects cut_day BBVA (on cut)", async () => {
  setRule({ chatId: "2", cardName: "BBVA Platino", cutDay: 2, shift: 0 });
  const billingMonth = await getBillingMonthForPurchase({
    chatId: "2",
    cardName: "BBVA Platino",
    purchaseDateISO: "2026-01-02",
    getCardRuleFn
  });
  assert.equal(billingMonth, "2026-01-01");
});

test("billing month respects cut_day Santander", async () => {
  setRule({ chatId: "3", cardName: "Santander", cutDay: 9, shift: 0 });
  const billingMonth = await getBillingMonthForPurchase({
    chatId: "3",
    cardName: "Santander",
    purchaseDateISO: "2026-01-11",
    getCardRuleFn
  });
  assert.equal(billingMonth, "2026-02-01");
});

test("billing month supports negative shift (Klar)", async () => {
  setRule({ chatId: "4", cardName: "Klar", cutDay: 30, shift: -1 });
  const billingMonth = await getBillingMonthForPurchase({
    chatId: "4",
    cardName: "Klar",
    purchaseDateISO: "2026-01-19",
    getCardRuleFn
  });
  assert.equal(billingMonth, "2025-12-01");
});

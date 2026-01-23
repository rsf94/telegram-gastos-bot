import assert from "node:assert/strict";
import test from "node:test";
import { getCashflowMonthForPurchase } from "../web/lib/cashflow.js";


test("BBVA cut day 2 pushes late-month purchase to next month cashflow", () => {
  const cashflowMonth = getCashflowMonthForPurchase({
    purchaseDateISO: "2024-05-15",
    cutDay: 2,
    payOffsetDays: 20,
    rollWeekendToMonday: false
  });

  assert.equal(cashflowMonth, "2024-06-01");
});

test("Banorte cut day 24 keeps early purchase in same month cashflow", () => {
  const cashflowMonth = getCashflowMonthForPurchase({
    purchaseDateISO: "2024-05-10",
    cutDay: 24,
    payOffsetDays: 10,
    rollWeekendToMonday: false
  });

  assert.equal(cashflowMonth, "2024-06-01");
});

test("Klar rolls weekend pay date to Monday", () => {
  const cashflowMonth = getCashflowMonthForPurchase({
    purchaseDateISO: "2024-03-02",
    cutDay: 4,
    payOffsetDays: 2,
    rollWeekendToMonday: true
  });

  assert.equal(cashflowMonth, "2024-03-01");
});

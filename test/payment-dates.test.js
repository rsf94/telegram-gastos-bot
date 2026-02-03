import test from "node:test";
import assert from "node:assert/strict";

import { getUpcomingPaymentDates } from "../src/payments.js";

test("upcoming payments roll weekend to Monday", async () => {
  const { entries } = getUpcomingPaymentDates({
    todayISO: "2024-05-31",
    rules: [
      {
        card_name: "BBVA",
        cut_day: 1,
        pay_offset_days: 0,
        roll_weekend_to_monday: true,
        active: true
      }
    ]
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].payISO, "2024-06-03");
});

test("upcoming payments jump to next cycle when current pay date passed", async () => {
  const { entries } = getUpcomingPaymentDates({
    todayISO: "2024-06-25",
    rules: [
      {
        card_name: "Santander",
        cut_day: 5,
        pay_offset_days: 10,
        roll_weekend_to_monday: false,
        active: true
      }
    ]
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].payISO, "2024-07-15");
});

test("upcoming payments are sorted by next pay date", async () => {
  const { entries } = getUpcomingPaymentDates({
    todayISO: "2024-01-01",
    rules: [
      {
        card_name: "Largo",
        cut_day: 2,
        pay_offset_days: 20,
        roll_weekend_to_monday: false,
        active: true
      },
      {
        card_name: "Corto",
        cut_day: 1,
        pay_offset_days: 0,
        roll_weekend_to_monday: false,
        active: true
      }
    ]
  });

  assert.equal(entries.length, 2);
  assert.equal(entries[0].cardName, "Corto");
  assert.equal(entries[1].cardName, "Largo");
});

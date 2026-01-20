import test from "node:test";
import assert from "node:assert/strict";
const rules = new Map();

function setRule({ chatId, cardName, cutDay, shift }) {
  rules.set(`${chatId}|${cardName}`, {
    cut_day: cutDay,
    billing_shift_months: shift
  });
}

function calcMonth({ baseDate, shift }) {
  const year = baseDate.getUTCFullYear();
  const month = baseDate.getUTCMonth();
  const shifted = new Date(Date.UTC(year, month + shift, 1, 12, 0, 0));
  return shifted.toISOString().slice(0, 10);
}

class FakeBigQuery {
  async createQueryJob(options) {
    const { query, params } = options;
    const key = `${params.chat_id}|${params.card_name}`;
    const rule = rules.get(key);
    const rows = [];
    if (rule) {
      const purchaseDate = new Date(`${params.purchase_date}T00:00:00Z`);
      const purchaseMonth = new Date(
        Date.UTC(purchaseDate.getUTCFullYear(), purchaseDate.getUTCMonth(), 1, 12, 0, 0)
      );
      let baseMonth = purchaseMonth;
      if (query.includes("EXTRACT(DAY") && query.includes("> cut_day")) {
        if (purchaseDate.getUTCDate() > rule.cut_day) {
          baseMonth = new Date(
            Date.UTC(purchaseMonth.getUTCFullYear(), purchaseMonth.getUTCMonth() + 1, 1, 12, 0, 0)
          );
        }
      }
      rows.push({
        billing_month: calcMonth({
          baseDate: baseMonth,
          shift: rule.billing_shift_months
        })
      });
    }
    return [
      {
        async getQueryResults() {
          return [rows];
        }
      }
    ];
  }
}

const { getBillingMonthForPurchase } = await import("../src/storage/bigquery.js");

test("billing month respects cut_day BBVA (after cut)", async () => {
  setRule({ chatId: "1", cardName: "BBVA Platino", cutDay: 2, shift: 0 });
  const billingMonth = await getBillingMonthForPurchase({
    chatId: "1",
    cardName: "BBVA Platino",
    purchaseDateISO: "2026-01-19",
    bqClient: new FakeBigQuery()
  });
  assert.equal(billingMonth, "2026-02-01");
});

test("billing month respects cut_day BBVA (on cut)", async () => {
  setRule({ chatId: "2", cardName: "BBVA Platino", cutDay: 2, shift: 0 });
  const billingMonth = await getBillingMonthForPurchase({
    chatId: "2",
    cardName: "BBVA Platino",
    purchaseDateISO: "2026-01-02",
    bqClient: new FakeBigQuery()
  });
  assert.equal(billingMonth, "2026-01-01");
});

test("billing month respects cut_day Santander", async () => {
  setRule({ chatId: "3", cardName: "Santander", cutDay: 9, shift: 0 });
  const billingMonth = await getBillingMonthForPurchase({
    chatId: "3",
    cardName: "Santander",
    purchaseDateISO: "2026-01-11",
    bqClient: new FakeBigQuery()
  });
  assert.equal(billingMonth, "2026-02-01");
});

test("billing month supports negative shift (Klar)", async () => {
  setRule({ chatId: "4", cardName: "Klar", cutDay: 30, shift: -1 });
  const billingMonth = await getBillingMonthForPurchase({
    chatId: "4",
    cardName: "Klar",
    purchaseDateISO: "2026-01-19",
    bqClient: new FakeBigQuery()
  });
  assert.equal(billingMonth, "2025-12-01");
});

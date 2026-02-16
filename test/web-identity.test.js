import test from "node:test";
import assert from "node:assert/strict";

import {
  consumeLinkToken,
  ensureUserExists,
  normalizeEmail
} from "../web/lib/dashboard_identity.js";
import { handleCashflowRequest } from "../web/lib/cashflow_api.js";

test("normalizeEmail trims and lowercases", () => {
  assert.equal(normalizeEmail("  User.Name+X@Example.COM  "), "user.name+x@example.com");
});

test("ensureUserExists inserts users row when missing", async () => {
  const inserted = [];
  const fakeBq = {
    async query() {
      return [[]];
    },
    dataset() {
      return {
        table() {
          return {
            async insert(rows) {
              inserted.push(...rows);
            }
          };
        }
      };
    }
  };

  const result = await ensureUserExists({
    bq: fakeBq,
    projectId: "proj",
    dataset: "gastos",
    email: "Test@Example.com"
  });

  assert.equal(result.created, true);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].email, "test@example.com");
  assert.ok(inserted[0].user_id);
});

test("consumeLinkToken inserts chat_links row and avoids updates", async () => {
  const tableInserts = [];
  const fakeBq = {
    async query() {
      return [[{ chat_id: "12345" }]];
    },
    dataset() {
      return {
        table(tableName) {
          return {
            async insert(rows) {
              tableInserts.push({ tableName, rows });
            }
          };
        }
      };
    }
  };

  const chatId = await consumeLinkToken({
    bq: fakeBq,
    projectId: "proj",
    dataset: "gastos",
    linkToken: "tok.abc",
    userId: "user-1",
    email: "u@example.com"
  });

  assert.equal(chatId, "12345");
  assert.equal(tableInserts.length, 2);
  assert.equal(tableInserts[0].tableName, "chat_links");
  assert.equal(tableInserts[0].rows[0].status, "LINKED");
  assert.equal(tableInserts[1].tableName, "user_links");
  assert.equal(typeof fakeBq.update, "undefined");
});

test("cashflow API resolves authorization via users -> chat_links", async () => {
  const queriedChatIds = [];
  const fakeBq = {
    async query({ query, params }) {
      if (query.includes("FROM `proj.gastos.users`")) {
        return [[{ user_id: "user-1" }]];
      }
      if (query.includes("FROM `proj.gastos.chat_links`")) {
        return [[{ chat_id: "777" }]];
      }
      if (query.includes("FROM `proj.gastos.card_rules`")) {
        queriedChatIds.push(params.chat_id);
        return [[{ card_name: "BBVA", cut_day: 2, pay_offset_days: 20, roll_weekend_to_monday: false }]];
      }
      if (query.includes("FROM `proj.gastos.expenses`")) {
        queriedChatIds.push(params.chat_id);
        return [[{ card_name: "BBVA", purchase_date: "2024-01-10", total: 100 }]];
      }
      if (query.includes("FROM `proj.gastos.installments`")) {
        queriedChatIds.push(params.chat_id);
        return [[]];
      }
      throw new Error(`Unexpected query: ${query}`);
    },
    dataset() {
      return {
        table() {
          return {
            async insert() {}
          };
        }
      };
    }
  };

  const request = new Request(
    "http://localhost/api/cashflow?from=2024-01-01&to=2024-03-01",
    {
      headers: {
        "x-user-email": "Person@Example.com"
      }
    }
  );

  const response = await handleCashflowRequest({
    request,
    bq: fakeBq,
    env: {
      BQ_PROJECT_ID: "proj",
      BQ_DATASET: "gastos",
      BQ_TABLE: "expenses"
    }
  });

  assert.equal(response.status, 200);
  assert.deepEqual(queriedChatIds, ["777", "777", "777"]);
});

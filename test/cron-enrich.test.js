import test from "node:test";
import assert from "node:assert/strict";

import { processEnrichmentRetryQueue } from "../src/usecases/enrichment_retry.js";
import { BQ_ENRICHMENT_RETRY_TABLE } from "../src/config.js";

function parseLimit(query) {
  const match = query.match(/LIMIT\s+(\d+)/i);
  return match ? Number(match[1]) : 50;
}

function latestByExpense(rows) {
  const latest = new Map();
  for (const row of rows) {
    const existing = latest.get(row.expense_id);
    if (!existing) {
      latest.set(row.expense_id, row);
      continue;
    }
    const existingTime = new Date(existing.updated_at || existing.created_at || 0).getTime();
    const currentTime = new Date(row.updated_at || row.created_at || 0).getTime();
    if (currentTime >= existingTime) {
      latest.set(row.expense_id, row);
    }
  }
  return Array.from(latest.values());
}

function createFakeBigQuery({ enrichmentRows = [] } = {}) {
  const rows = enrichmentRows.map((row) => ({ ...row }));

  const dataset = () => ({
    table: (tableName) => ({
      insert: async (newRows) => {
        if (tableName !== BQ_ENRICHMENT_RETRY_TABLE) return;
        for (const row of newRows) {
          rows.push({ ...row });
        }
      }
    })
  });

  const createQueryJob = async ({ query, params }) => {
    const nowIso = params?.now;

    if (query.includes("COUNTIF") && query.includes("total_pending")) {
      const latest = latestByExpense(rows).filter((row) => row.status !== "SUCCEEDED");
      const notDue = latest.filter((row) => {
        const next = row.next_attempt_at ? new Date(row.next_attempt_at).getTime() : 0;
        return next > new Date(nowIso).getTime();
      }).length;
      const totalPending = latest.length;
      return [
        {
          getQueryResults: async () => [[{ not_due: notDue, total_pending: totalPending }]]
        }
      ];
    }

    if (query.includes(`.${BQ_ENRICHMENT_RETRY_TABLE}`)) {
      const limit = parseLimit(query);
      const nowTime = new Date(nowIso).getTime();
      const latest = latestByExpense(rows)
        .filter((row) => row.status !== "SUCCEEDED")
        .filter((row) => {
          const next = row.next_attempt_at ? new Date(row.next_attempt_at).getTime() : 0;
          return next <= nowTime;
        })
        .sort((a, b) => {
          const aTime = a.next_attempt_at ? new Date(a.next_attempt_at).getTime() : 0;
          const bTime = b.next_attempt_at ? new Date(b.next_attempt_at).getTime() : 0;
          return aTime - bTime;
        })
        .slice(0, limit);

      return [
        {
          getQueryResults: async () => [latest]
        }
      ];
    }

    throw new Error(`Unhandled query in fake BigQuery: ${query}`);
  };

  return {
    client: { dataset, createQueryJob },
    rows
  };
}

test("cron enrich returns skipped_not_due when no tasks are due", async () => {
  const now = new Date("2024-05-01T12:00:00Z");
  const fake = createFakeBigQuery({
    enrichmentRows: [
      {
        expense_id: "exp-1",
        chat_id: "1",
        status: "PENDING",
        attempts: 0,
        next_attempt_at: "2024-05-01T13:00:00Z",
        created_at: "2024-05-01T10:00:00Z",
        updated_at: "2024-05-01T10:00:00Z"
      }
    ]
  });

  const result = await processEnrichmentRetryQueue({
    limit: 10,
    nowFn: () => now,
    bigqueryClient: fake.client,
    getExpenseByIdFn: async () => null,
    enrichExpenseLLMFn: async () => ({})
  });

  assert.equal(result.claimed, 0);
  assert.equal(result.processed, 0);
  assert.equal(result.done, 0);
  assert.equal(result.failed, 0);
  assert.ok(result.skipped_not_due > 0);
  assert.equal(result.skipped_noop, 0);
});

test("cron enrich processes a due task successfully", async () => {
  const now = new Date("2024-05-01T12:00:00Z");
  const fake = createFakeBigQuery({
    enrichmentRows: [
      {
        expense_id: "exp-2",
        chat_id: "2",
        status: "PENDING",
        attempts: 0,
        next_attempt_at: "2024-05-01T11:00:00Z",
        created_at: "2024-05-01T10:00:00Z",
        updated_at: "2024-05-01T10:00:00Z"
      }
    ]
  });

  const result = await processEnrichmentRetryQueue({
    limit: 10,
    nowFn: () => now,
    bigqueryClient: fake.client,
    getExpenseByIdFn: async () => ({
      id: "exp-2",
      raw_text: "Uber 120",
      amount_mxn: "120",
      payment_method: "BBVA",
      purchase_date: "2024-05-01"
    }),
    enrichExpenseLLMFn: async () => ({
      category: "Transport",
      merchant: "Uber",
      description: "Ride",
      llm_provider: "gemini"
    }),
    updateExpenseEnrichmentFn: async () => {}
  });

  assert.equal(result.claimed, 1);
  assert.equal(result.processed, 1);
  assert.equal(result.done, 1);
  assert.equal(result.failed, 0);

  const latest = latestByExpense(fake.rows);
  const latestRow = latest.find((row) => row.expense_id === "exp-2");
  assert.equal(latestRow.status, "SUCCEEDED");

  const dueAfter = latest
    .filter((row) => row.status !== "SUCCEEDED")
    .filter((row) => {
      const next = row.next_attempt_at ? new Date(row.next_attempt_at).getTime() : 0;
      return next <= now.getTime();
    });
  assert.equal(dueAfter.length, 0);
});

test("cron enrich retries when update fails with retryable error", async () => {
  const now = new Date("2024-05-01T12:00:00Z");
  const fake = createFakeBigQuery({
    enrichmentRows: [
      {
        expense_id: "exp-3",
        chat_id: "3",
        status: "PENDING",
        attempts: 0,
        category: "Other",
        merchant: "Store",
        description: "Test",
        next_attempt_at: "2024-05-01T11:00:00Z",
        created_at: "2024-05-01T10:00:00Z",
        updated_at: "2024-05-01T10:00:00Z"
      }
    ]
  });

  const result = await processEnrichmentRetryQueue({
    limit: 10,
    nowFn: () => now,
    bigqueryClient: fake.client,
    getExpenseByIdFn: async () => ({
      id: "exp-3",
      raw_text: "Tienda 200",
      amount_mxn: "200",
      payment_method: "BBVA",
      purchase_date: "2024-05-01"
    }),
    updateExpenseEnrichmentFn: async () => {
      throw new Error("would affect rows in the streaming buffer");
    }
  });

  assert.equal(result.processed, 1);
  assert.equal(result.done, 0);
  assert.equal(result.failed, 1);

  const latest = latestByExpense(fake.rows);
  const latestRow = latest.find((row) => row.expense_id === "exp-3");
  assert.equal(latestRow.status, "FAILED");
  assert.equal(latestRow.attempts, 1);
  assert.ok(new Date(latestRow.next_attempt_at).getTime() > now.getTime());
  assert.ok(String(latestRow.last_error).includes("streaming buffer"));
});

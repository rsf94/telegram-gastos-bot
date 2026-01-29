import crypto from "crypto";
import { enrichExpenseLLM } from "../gemini.js";
import {
  createEnrichmentRetryStore,
  getDueEnrichmentRetries,
  getEnrichmentRetryStats,
  getExpenseById,
  insertEnrichmentRetryEvent
} from "../storage/bigquery.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RETRYABLE_PATTERNS = [
  "streaming buffer",
  "would affect rows in the streaming buffer",
  "no rows",
  "not found",
  "notfound",
  "not_found"
];

function isRetryableEnrichmentError(error) {
  if (!error) return false;
  if (error.code === "BQ_UPDATE_NO_ROWS") return true;
  const message = String(error.message || error || "").toLowerCase();
  return RETRYABLE_PATTERNS.some((pattern) => message.includes(pattern));
}

function shortError(error) {
  const msg = error?.message || String(error || "");
  return msg.split("\n")[0].slice(0, 180);
}

function logEnrichRetry({ expenseId, attempt, status, reason, nextAttemptAt, bqUpdateMs }) {
  const payload = {
    type: "enrich_retry",
    expense_id: expenseId,
    attempt,
    status,
    reason,
    next_attempt_at: nextAttemptAt,
    bq_update_ms: bqUpdateMs
  };
  console.log(JSON.stringify(payload));
}

export async function runEnrichmentUpdateWithRetry({
  chatId,
  expenseId,
  category,
  merchant,
  description,
  updateExpenseEnrichmentFn,
  enqueueEnrichmentRetryFn,
  backoffMs = [1000, 3000, 10000, 30000],
  sleepFn = sleep,
  nowFn = () => new Date()
}) {
  let lastError = null;

  for (let attempt = 1; attempt <= backoffMs.length + 1; attempt += 1) {
    const updateStart = Date.now();
    try {
      await updateExpenseEnrichmentFn({
        chatId,
        expenseId,
        category,
        merchant,
        description
      });
      const bqUpdateMs = Date.now() - updateStart;
      logEnrichRetry({
        expenseId,
        attempt,
        status: "success",
        reason: "ok",
        nextAttemptAt: null,
        bqUpdateMs
      });
      return { ok: true, attempts: attempt };
    } catch (error) {
      lastError = error;
      const retryable = isRetryableEnrichmentError(error);
      const bqUpdateMs = Date.now() - updateStart;
      const reason = shortError(error);
      const hasNext = attempt <= backoffMs.length;

      if (retryable && hasNext) {
        const delayMs = backoffMs[attempt - 1];
        const nextAttemptAt = new Date(nowFn().getTime() + delayMs).toISOString();
        logEnrichRetry({
          expenseId,
          attempt,
          status: "fail",
          reason,
          nextAttemptAt,
          bqUpdateMs
        });
        await sleepFn(delayMs);
        continue;
      }

      if (retryable && enqueueEnrichmentRetryFn) {
        const nextAttemptAt = new Date(nowFn().getTime() + 5 * 60 * 1000).toISOString();
        await enqueueEnrichmentRetryFn({
          expenseId,
          chatId,
          category,
          merchant,
          description,
          attempts: 0,
          nextAttemptAt,
          lastError: reason
        });
        logEnrichRetry({
          expenseId,
          attempt,
          status: "fail",
          reason,
          nextAttemptAt,
          bqUpdateMs
        });
      } else {
        logEnrichRetry({
          expenseId,
          attempt,
          status: "fail",
          reason: retryable ? reason : `non_retryable:${reason}`,
          nextAttemptAt: null,
          bqUpdateMs
        });
      }

      return { ok: false, attempts: attempt, error };
    }
  }

  return { ok: false, attempts: backoffMs.length + 1, error: lastError };
}

function cronBackoffMsForAttempt(attempt) {
  const delays = [30, 60, 120, 240, 480, 1440].map((minutes) => minutes * 60 * 1000);
  const idx = Math.max(0, Math.min(attempt - 1, delays.length - 1));
  return delays[idx];
}

export async function processEnrichmentRetryQueue({
  limit = 50,
  getDueEnrichmentRetryTasksFn = getDueEnrichmentRetries,
  getEnrichmentRetryStatsFn = getEnrichmentRetryStats,
  getExpenseByIdFn = getExpenseById,
  enrichExpenseLLMFn = enrichExpenseLLM,
  updateExpenseEnrichmentFn,
  insertEnrichmentRetryEventFn = insertEnrichmentRetryEvent,
  nowFn = () => new Date(),
  runId = crypto.randomUUID(),
  bigqueryClient
}) {
  const store = bigqueryClient ? createEnrichmentRetryStore({ bigqueryClient }) : null;
  const hasCustomDueFn = getDueEnrichmentRetryTasksFn !== getDueEnrichmentRetries;
  const hasCustomStatsFn = getEnrichmentRetryStatsFn !== getEnrichmentRetryStats;
  const hasCustomExpenseFn = getExpenseByIdFn !== getExpenseById;
  const hasCustomInsertFn = insertEnrichmentRetryEventFn !== insertEnrichmentRetryEvent;

  const getDueTasks =
    !hasCustomDueFn && store?.getDueEnrichmentRetries
      ? store.getDueEnrichmentRetries
      : getDueEnrichmentRetryTasksFn;
  let getStats = null;
  if (hasCustomStatsFn) {
    getStats = getEnrichmentRetryStatsFn;
  } else if (!hasCustomDueFn) {
    getStats = store?.getEnrichmentRetryStats || getEnrichmentRetryStatsFn;
  }
  const getExpense =
    !hasCustomExpenseFn && store?.getExpenseById ? store.getExpenseById : getExpenseByIdFn;
  const insertEvent =
    !hasCustomInsertFn && store?.insertEnrichmentRetryEvent
      ? store.insertEnrichmentRetryEvent
      : insertEnrichmentRetryEventFn;

  const now = nowFn();
  const tasks = await getDueTasks({ limit, now });
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let llmMsTotal = 0;
  let bqMsTotal = 0;
  let skippedNotDue = 0;
  const llmProviders = new Set();
  let pendingTotal = 0;

  if (getStats) {
    try {
      const stats = await getStats({ now });
      skippedNotDue = Number(stats?.notDue || 0);
      pendingTotal = Number(stats?.totalPending || 0);
    } catch (error) {
      const reason = shortError(error);
      console.warn(`enrich_retry_stats_error: ${reason}`);
    }
  }

  for (const task of tasks) {
    if (!task?.expense_id || !task?.chat_id) {
      skipped += 1;
      continue;
    }

    const attempt = Number(task.attempts || 0) + 1;
    const runningStart = Date.now();
    await insertEvent({
      expenseId: task.expense_id,
      chatId: task.chat_id,
      attempts: attempt,
      nextAttemptAt: now.toISOString(),
      lastError: null,
      status: "RUNNING",
      runId
    });
    bqMsTotal += Date.now() - runningStart;

    let expense = null;
    try {
      expense = await getExpense({
        chatId: task.chat_id,
        expenseId: task.expense_id
      });
    } catch (error) {
      const reason = shortError(error);
      const delayMs = cronBackoffMsForAttempt(attempt);
      const nextAttemptAt = new Date(nowFn().getTime() + delayMs).toISOString();
      const insertStart = Date.now();
      await insertEvent({
        expenseId: task.expense_id,
        chatId: task.chat_id,
        attempts: attempt,
        nextAttemptAt,
        lastError: reason,
        status: "FAILED",
        runId
      });
      bqMsTotal += Date.now() - insertStart;
      failed += 1;
      continue;
    }

    if (!expense) {
      const reason = "expense_not_found";
      const delayMs = cronBackoffMsForAttempt(attempt);
      const nextAttemptAt = new Date(nowFn().getTime() + delayMs).toISOString();
      const insertStart = Date.now();
      await insertEvent({
        expenseId: task.expense_id,
        chatId: task.chat_id,
        attempts: attempt,
        nextAttemptAt,
        lastError: reason,
        status: "FAILED",
        runId
      });
      bqMsTotal += Date.now() - insertStart;
      failed += 1;
      continue;
    }

    let enrichment = null;
    const hasStoredEnrichment =
      task.category != null || task.merchant != null || task.description != null;

    if (hasStoredEnrichment) {
      enrichment = {
        category: task.category || "Other",
        merchant: task.merchant || null,
        description: task.description || "Gasto"
      };
    } else {
      const llmStart = Date.now();
      try {
        const ai = await enrichExpenseLLMFn({
          text: expense.raw_text || "",
          baseDraft: expense
        });
        enrichment = {
          category: ai.category,
          merchant: ai.merchant,
          description: ai.description
        };
        llmProviders.add(ai.llm_provider || "unknown");
        llmMsTotal += Date.now() - llmStart;
      } catch (error) {
        llmMsTotal += Date.now() - llmStart;
        const reason = shortError(error);
        const delayMs = cronBackoffMsForAttempt(attempt);
        const nextAttemptAt = new Date(nowFn().getTime() + delayMs).toISOString();
        const insertStart = Date.now();
        await insertEvent({
          expenseId: task.expense_id,
          chatId: task.chat_id,
          attempts: attempt,
          nextAttemptAt,
          lastError: reason,
          status: "FAILED",
          runId
        });
        bqMsTotal += Date.now() - insertStart;
        failed += 1;
        continue;
      }
    }

    if (updateExpenseEnrichmentFn) {
      const updateStart = Date.now();
      try {
        await updateExpenseEnrichmentFn({
          chatId: task.chat_id,
          expenseId: task.expense_id,
          category: enrichment.category,
          merchant: enrichment.merchant,
          description: enrichment.description
        });
        bqMsTotal += Date.now() - updateStart;
      } catch (error) {
        bqMsTotal += Date.now() - updateStart;
        const reason = shortError(error);
        const retryable = isRetryableEnrichmentError(error);
        const delayMs = cronBackoffMsForAttempt(attempt);
        const nextAttemptAt = retryable
          ? new Date(nowFn().getTime() + delayMs).toISOString()
          : new Date(nowFn().getTime() + cronBackoffMsForAttempt(6)).toISOString();
        const insertStart = Date.now();
        await insertEvent({
          expenseId: task.expense_id,
          chatId: task.chat_id,
          attempts: attempt,
          nextAttemptAt,
          lastError: retryable ? reason : `non_retryable:${reason}`,
          status: "FAILED",
          runId,
          category: enrichment.category,
          merchant: enrichment.merchant,
          description: enrichment.description
        });
        bqMsTotal += Date.now() - insertStart;
        failed += 1;
        continue;
      }
    }

    const successStart = Date.now();
    await insertEvent({
      expenseId: task.expense_id,
      chatId: task.chat_id,
      attempts: attempt,
      nextAttemptAt: null,
      lastError: null,
      status: "SUCCEEDED",
      runId,
      category: enrichment.category,
      merchant: enrichment.merchant,
      description: enrichment.description
    });
    bqMsTotal += Date.now() - successStart;
    succeeded += 1;
  }

  const processed = succeeded + failed;
  const skippedNoop = tasks.length === 0 && skippedNotDue === 0 ? 1 : 0;

  return {
    claimed: tasks.length,
    processed,
    done: succeeded,
    failed,
    skipped_not_due: skippedNotDue,
    skipped_noop: skippedNoop,
    llmMs: llmMsTotal,
    bqMs: bqMsTotal,
    llmProviders: Array.from(llmProviders),
    pending: pendingTotal,
    skipped_invalid: skipped
  };
}

export { isRetryableEnrichmentError };

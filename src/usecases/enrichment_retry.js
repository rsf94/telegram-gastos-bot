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
  const delays = [5, 15, 30, 60].map((minutes) => minutes * 60 * 1000);
  const idx = Math.max(0, Math.min(attempt - 1, delays.length - 1));
  return delays[idx];
}

export async function processEnrichmentRetryQueue({
  limit = 50,
  getDueEnrichmentRetryTasksFn,
  updateExpenseEnrichmentFn,
  updateEnrichmentRetryTaskFn,
  deleteEnrichmentRetryTaskFn,
  nowFn = () => new Date()
}) {
  const tasks = await getDueEnrichmentRetryTasksFn({ limit, now: nowFn() });

  for (const task of tasks) {
    const attempt = Number(task.attempts || 0) + 1;
    const updateStart = Date.now();
    try {
      await updateExpenseEnrichmentFn({
        chatId: task.chat_id,
        expenseId: task.expense_id,
        category: task.category,
        merchant: task.merchant,
        description: task.description
      });
      const bqUpdateMs = Date.now() - updateStart;
      logEnrichRetry({
        expenseId: task.expense_id,
        attempt,
        status: "success",
        reason: "ok",
        nextAttemptAt: null,
        bqUpdateMs
      });
      await deleteEnrichmentRetryTaskFn({
        expenseId: task.expense_id,
        chatId: task.chat_id
      });
      continue;
    } catch (error) {
      const bqUpdateMs = Date.now() - updateStart;
      const reason = shortError(error);
      const retryable = isRetryableEnrichmentError(error);
      const updatedAttempts = attempt;

      if (!retryable) {
        logEnrichRetry({
          expenseId: task.expense_id,
          attempt,
          status: "fail",
          reason: `non_retryable:${reason}`,
          nextAttemptAt: null,
          bqUpdateMs
        });
        await deleteEnrichmentRetryTaskFn({
          expenseId: task.expense_id,
          chatId: task.chat_id
        });
        continue;
      }

      if (updatedAttempts > 10) {
        logEnrichRetry({
          expenseId: task.expense_id,
          attempt,
          status: "dead",
          reason,
          nextAttemptAt: null,
          bqUpdateMs
        });
        await deleteEnrichmentRetryTaskFn({
          expenseId: task.expense_id,
          chatId: task.chat_id
        });
        continue;
      }

      const delayMs = cronBackoffMsForAttempt(updatedAttempts);
      const nextAttemptAt = new Date(nowFn().getTime() + delayMs).toISOString();
      await updateEnrichmentRetryTaskFn({
        expenseId: task.expense_id,
        chatId: task.chat_id,
        attempts: updatedAttempts,
        nextAttemptAt,
        lastError: reason
      });
      logEnrichRetry({
        expenseId: task.expense_id,
        attempt,
        status: "fail",
        reason,
        nextAttemptAt,
        bqUpdateMs
      });
    }
  }

  return { processed: tasks.length };
}

export { isRetryableEnrichmentError };

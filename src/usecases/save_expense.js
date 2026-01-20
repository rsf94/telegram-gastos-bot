import { LLM_PROVIDER } from "../config.js";
import { insertExpenseAndMaybeInstallments } from "../storage/bigquery.js";
import { escapeHtml, tgSend } from "../telegram.js";

const PERF_TELEGRAM = process.env.PERF_TELEGRAM === "1";

function formatBigQueryError(e) {
  if (!e) return "Error desconocido";

  // BigQuery insert puede tirar PartialFailureError con .errors
  if (e.name === "PartialFailureError" && Array.isArray(e.errors)) {
    const first = e.errors[0];
    const inner = first?.errors?.[0];
    if (inner) {
      const loc = inner.location ? ` en "${inner.location}"` : "";
      return `BigQuery rechazó el registro${loc}: ${inner.message || inner.reason || "invalid"}`;
    }
    return "BigQuery rechazó el registro (PartialFailureError).";
  }

  return e.message || String(e);
}

function logBigQueryError(e) {
  console.error("❌ Error al guardar en BigQuery:", e?.name, e?.message);
  try {
    console.error("BigQuery e.errors:", JSON.stringify(e?.errors, null, 2));
  } catch (_) {
    // ignore
  }
}

function shortError(error) {
  const msg = error?.message || String(error || "");
  return msg.split("\n")[0].slice(0, 180);
}

function logPerf(payload, level = "log") {
  const base = {
    type: "perf",
    ...payload
  };
  if (level === "warn") {
    console.warn(JSON.stringify(base));
  } else {
    console.log(JSON.stringify(base));
  }
}

function formatPerfLine({ totalMs, llmMs, bqMs }) {
  return `⏱️ ${totalMs}ms (LLM ${llmMs}ms, BQ ${bqMs}ms)`;
}

export async function saveExpense({
  chatId,
  draft,
  insertExpense = insertExpenseAndMaybeInstallments,
  sendMessage = tgSend,
  llmProviderEnv = LLM_PROVIDER,
  perfTelegram = PERF_TELEGRAM
}) {
  const perf = draft.__perf || {};
  const localParseMs = Number(perf.local_parse_ms || 0);
  const llmMs = Number(perf.llm_ms || 0);
  const llmProvider = perf.llm_provider || String(llmProviderEnv || "local");
  const bqStart = Date.now();

  try {
    const expenseId = await insertExpense(draft, chatId);
    const bqMs = Date.now() - bqStart;
    const totalMs = localParseMs + llmMs + bqMs;

    logPerf({
      flow: "expense_create",
      local_parse_ms: localParseMs,
      llm_ms: llmMs,
      bq_ms: bqMs,
      total_ms: totalMs,
      llm_provider: llmProvider,
      ok: true,
      err_short: null
    });

    const perfLine = perfTelegram ? `\n${formatPerfLine({ totalMs, llmMs, bqMs })}` : "";
    await sendMessage(
      chatId,
      `✅ <b>Guardado</b>\nID: <code>${escapeHtml(expenseId)}</code>${perfLine}`
    );

    return { ok: true, expenseId };
  } catch (e) {
    const bqMs = Date.now() - bqStart;
    const totalMs = localParseMs + llmMs + bqMs;

    logPerf(
      {
        flow: "expense_create",
        local_parse_ms: localParseMs,
        llm_ms: llmMs,
        bq_ms: bqMs,
        total_ms: totalMs,
        llm_provider: llmProvider,
        ok: false,
        err_short: shortError(e)
      },
      "warn"
    );

    logBigQueryError(e);
    const pretty = formatBigQueryError(e);
    await sendMessage(chatId, `❌ <b>No se pudo guardar</b>\n${escapeHtml(pretty)}`);

    return { ok: false, error: e };
  }
}

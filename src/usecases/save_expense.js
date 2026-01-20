import { LLM_PROVIDER } from "../config.js";
import {
  insertExpenseAndMaybeInstallments,
  updateExpenseEnrichment
} from "../storage/bigquery.js";
import { escapeHtml, tgSend } from "../telegram.js";
import { enrichExpenseLLM } from "../gemini.js";

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
  const base = { type: "perf", ...payload };
  if (level === "warn") {
    console.warn(JSON.stringify(base));
  } else {
    console.log(JSON.stringify(base));
  }
}

export async function saveExpense({
  chatId,
  draft,
  insertExpense = insertExpenseAndMaybeInstallments,
  sendMessage = tgSend,
  updateExpenseEnrichmentFn = updateExpenseEnrichment,
  enrichExpenseLLMFn = enrichExpenseLLM,
  llmProviderEnv = LLM_PROVIDER
}) {
  const perf = draft.__perf || {};
  const parseMs = Number(perf.parse_ms || 0);
  const bqStart = Date.now();
  const preferredProvider = String(llmProviderEnv || "local");

  try {
    const expenseId = await insertExpense(draft, chatId);
    const bqInsertMs = Date.now() - bqStart;
    await sendMessage(chatId, "Guardado ✅");

    const flow = draft.is_msi ? "msi" : "normal";

    void (async () => {
      const llmStart = Date.now();
      let llmMs = 0;
      let bqUpdateMs = 0;
      let llmProvider = preferredProvider;
      let usedFallback = false;

      try {
        const ai = await enrichExpenseLLMFn({ text: draft.raw_text || "", baseDraft: draft });
        llmMs = Date.now() - llmStart;
        llmProvider = ai.llm_provider || llmProvider;
        usedFallback = llmProvider !== preferredProvider;

        const enrichment =
          llmProvider === "local"
            ? {
                category: draft.category,
                merchant: draft.merchant,
                description: draft.description
              }
            : {
                category: ai.category,
                merchant: ai.merchant,
                description: ai.description
              };

        const updateStart = Date.now();
        await updateExpenseEnrichmentFn({
          chatId,
          expenseId,
          category: enrichment.category,
          merchant: enrichment.merchant,
          description: enrichment.description
        });
        bqUpdateMs = Date.now() - updateStart;

        const totalMs = parseMs + bqInsertMs + llmMs + bqUpdateMs;
        logPerf({
          flow,
          parse_ms: parseMs,
          bq_insert_ms: bqInsertMs,
          llm_ms: llmMs,
          bq_update_ms: bqUpdateMs,
          total_ms: totalMs,
          llm_provider: llmProvider,
          used_fallback: usedFallback
        });
      } catch (error) {
        llmMs = Date.now() - llmStart;
        const totalMs = parseMs + bqInsertMs + llmMs + bqUpdateMs;
        logPerf(
          {
            flow,
            parse_ms: parseMs,
            bq_insert_ms: bqInsertMs,
            llm_ms: llmMs,
            bq_update_ms: bqUpdateMs,
            total_ms: totalMs,
            llm_provider: llmProvider,
            used_fallback,
            err_short: shortError(error)
          },
          "warn"
        );
      }
    })();

    return { ok: true, expenseId };
  } catch (e) {
    const bqInsertMs = Date.now() - bqStart;
    const flow = draft?.is_msi ? "msi" : "normal";
    logPerf(
      {
        flow,
        parse_ms: parseMs,
        bq_insert_ms: bqInsertMs,
        llm_ms: 0,
        bq_update_ms: 0,
        total_ms: parseMs + bqInsertMs,
        llm_provider: preferredProvider,
        used_fallback: false,
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

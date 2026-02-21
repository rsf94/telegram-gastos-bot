import crypto from "crypto";
import { LLM_PROVIDER } from "../config.js";
import {
  insertExpenseAndMaybeInstallments,
  resolveUserIdByChatId,
  updateExpenseEnrichment,
  enqueueEnrichmentRetry
} from "../storage/bigquery.js";
import { escapeHtml, tgSend } from "../telegram.js";
import { enrichExpenseLLM } from "../gemini.js";
import { runEnrichmentUpdateWithRetry } from "./enrichment_retry.js";
import {
  getIdempotencyEntry,
  setIdempotencyPending,
  setIdempotencySaved,
  clearIdempotencyEntry
} from "../cache/confirm_idempotency.js";

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

function buildIdempotencyKey({ chatId, draft }) {
  const payload = [
    String(chatId),
    draft.raw_text || "",
    draft.purchase_date || "",
    draft.payment_method || "",
    String(draft.amount_mxn ?? ""),
    draft.is_msi ? "1" : "0",
    String(draft.msi_months ?? ""),
    String(draft.msi_total_amount ?? "")
  ].join("||");

  return crypto.createHash("sha256").update(payload).digest("hex");
}

export async function saveExpense({
  chatId,
  draft,
  insertExpense = insertExpenseAndMaybeInstallments,
  sendMessage = tgSend,
  resolveUserIdByChatIdFn = resolveUserIdByChatId,
  updateExpenseEnrichmentFn = updateExpenseEnrichment,
  enqueueEnrichmentRetryFn = enqueueEnrichmentRetry,
  enrichExpenseLLMFn = enrichExpenseLLM,
  llmProviderEnv = LLM_PROVIDER
}) {
  const perf = draft.__perf || {};
  const parseMs = Number(perf.parse_ms || 0);
  const requestId = perf.request_id || null;
  const bqStart = Date.now();
  const preferredProvider = String(llmProviderEnv || "local");
  const cacheHitCardRules = perf.cache_hit?.card_rules ?? null;
  const baseOption = draft.is_msi ? "SAVE_MSI" : "SAVE_NORMAL";

  try {
    const idempotencyKey = buildIdempotencyKey({ chatId, draft });
    const cached = getIdempotencyEntry(idempotencyKey);
    if (cached?.status === "saved" || cached?.status === "pending") {
      const idText = cached?.expenseId
        ? ` ID: <code>${escapeHtml(cached.expenseId)}</code>`
        : "";
      await sendMessage(chatId, `✅ Ya estaba guardado.${idText}`);
      logPerf({
        request_id: requestId,
        flow: draft.is_msi ? "msi" : "normal",
        option: "SAVE_IDEMPOTENT",
        chat_id: chatId,
        local_parse_ms: parseMs,
        llm_ms: 0,
        bq_ms: 0,
        total_ms: parseMs,
        llm_provider: preferredProvider,
        cache_hit: { card_rules: cacheHitCardRules, llm: false },
        status: "ok"
      });
      return { ok: true, expenseId: cached?.expenseId || null, alreadySaved: true };
    }

    setIdempotencyPending(idempotencyKey);

    const userId = await resolveUserIdByChatIdFn(chatId);
    console.log(
      JSON.stringify({
        type: "expense_identity_resolution",
        chat_id: String(chatId),
        resolved_user_id: userId ?? null
      })
    );

    const tripId = draft?.trip_id || null;
    const draftWithIdentity = { ...draft, user_id: userId ?? null };
    const draftWithTrip = tripId
      ? { ...draftWithIdentity, trip_id: tripId }
      : draftWithIdentity;
    const expenseId = await insertExpense(draftWithTrip, chatId);
    setIdempotencySaved(idempotencyKey, expenseId);
    console.log(
      JSON.stringify({
        type: "expense_saved",
        expense_id: String(expenseId),
        chat_id: String(chatId),
        trip_id: tripId,
        has_trip: Boolean(tripId)
      })
    );
    const bqInsertMs = Date.now() - bqStart;
    await sendMessage(
      chatId,
      `✅ Guardado. ID: <code>${escapeHtml(expenseId)}</code>`
    );

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
        const llmCacheHit = Boolean(ai.cache_hit);

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
        const updateResult = await runEnrichmentUpdateWithRetry({
          chatId,
          expenseId,
          category: enrichment.category,
          merchant: enrichment.merchant,
          description: enrichment.description,
          updateExpenseEnrichmentFn,
          enqueueEnrichmentRetryFn
        });
        bqUpdateMs = Date.now() - updateStart;

        const bqMs = bqInsertMs + bqUpdateMs;
        const totalMs = parseMs + llmMs + bqMs;
        logPerf({
          request_id: requestId,
          flow,
          option: baseOption,
          chat_id: chatId,
          local_parse_ms: parseMs,
          llm_ms: llmMs,
          bq_ms: bqMs,
          total_ms: totalMs,
          llm_provider: llmProvider,
          cache_hit: { card_rules: cacheHitCardRules, llm: llmCacheHit },
          used_fallback: usedFallback,
          enrichment_update_ok: updateResult.ok,
          status: "ok"
        });
      } catch (error) {
        llmMs = Date.now() - llmStart;
        const bqMs = bqInsertMs + bqUpdateMs;
        const totalMs = parseMs + llmMs + bqMs;
        logPerf(
          {
            request_id: requestId,
            flow,
            option: baseOption,
            chat_id: chatId,
            local_parse_ms: parseMs,
            llm_ms: llmMs,
            bq_ms: bqMs,
            total_ms: totalMs,
            llm_provider: llmProvider,
            cache_hit: { card_rules: cacheHitCardRules, llm: false },
            used_fallback: usedFallback,
            err_short: shortError(error),
            status: "error",
            error: shortError(error)
          },
          "warn"
        );
      }
    })();

    return { ok: true, expenseId };
  } catch (e) {
    const tripId = draft?.trip_id || null;
    console.warn(
      JSON.stringify({
        type: "expense_save_error",
        chat_id: String(chatId),
        trip_id: tripId,
        msg: shortError(e)
      })
    );
    try {
      const idempotencyKey = buildIdempotencyKey({ chatId, draft });
      clearIdempotencyEntry(idempotencyKey);
    } catch (_) {
      // ignore cleanup errors
    }
    const bqInsertMs = Date.now() - bqStart;
    const flow = draft?.is_msi ? "msi" : "normal";
    logPerf(
      {
        request_id: requestId,
        flow,
        option: baseOption,
        chat_id: chatId,
        local_parse_ms: parseMs,
        llm_ms: 0,
        bq_ms: bqInsertMs,
        total_ms: parseMs + bqInsertMs,
        llm_provider: preferredProvider,
        cache_hit: { card_rules: cacheHitCardRules, llm: false },
        used_fallback: false,
        err_short: shortError(e),
        status: "error",
        error: shortError(e)
      },
      "warn"
    );
    logBigQueryError(e);
    const pretty = formatBigQueryError(e);
    await sendMessage(chatId, `❌ <b>No se pudo guardar</b>\n${escapeHtml(pretty)}`);

    return { ok: false, error: e };
  }
}

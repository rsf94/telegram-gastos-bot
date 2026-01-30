import { deleteExpenseCascade } from "../storage/bigquery.js";
import { tgSend } from "../telegram.js";

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

export async function deleteExpense({
  chatId,
  pendingDelete,
  requestId = null,
  deleteExpenseFn = deleteExpenseCascade,
  sendMessage = tgSend
}) {
  const bqStart = Date.now();

  try {
    const result = await deleteExpenseFn({
      chatId,
      expenseId: pendingDelete.expenseId
    });

    const bqMs = Date.now() - bqStart;
    logPerf({
      request_id: requestId,
      flow: "expense_delete",
      option: "DELETE",
      chat_id: chatId,
      local_parse_ms: 0,
      llm_ms: 0,
      bq_ms: bqMs,
      total_ms: bqMs,
      llm_provider: null,
      cache_hit: { card_rules: null, llm: false },
      status: "ok"
    });

    await sendMessage(
      chatId,
      `✅ <b>Borrado</b>. Installments eliminados: ${result.deletedInstallments}.`
    );

    return { ok: true, result };
  } catch (e) {
    const bqMs = Date.now() - bqStart;
    logPerf(
      {
        request_id: requestId,
        flow: "expense_delete",
        option: "DELETE",
        chat_id: chatId,
        local_parse_ms: 0,
        llm_ms: 0,
        bq_ms: bqMs,
        total_ms: bqMs,
        llm_provider: null,
        cache_hit: { card_rules: null, llm: false },
        status: "error",
        error: shortError(e)
      },
      "warn"
    );

    await sendMessage(chatId, "❌ <b>No se pudo borrar</b>.");
    return { ok: false, error: e };
  }
}

import {
  mainKeyboard,
  editMenuKeyboard,
  tgSend,
  answerCallbackQuery,
  tgEditMessage
} from "../telegram.js";
import { preview, validateDraft } from "../parsing.js";
import {
  getDraft,
  setDraft,
  clearDraft,
  getPendingDelete,
  clearPendingDelete,
  setLastExpenseId
} from "../state.js";
import { saveExpense } from "../usecases/save_expense.js";
import { deleteExpense } from "../usecases/delete_expense.js";
import { getActiveCardNames, getBillingMonthForPurchase } from "../storage/bigquery.js";
import { ALLOWED_PAYMENT_METHODS } from "../config.js";

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

export function createCallbackHandler({
  sendMessage = tgSend,
  editMessage = tgEditMessage,
  answerCallback = answerCallbackQuery,
  saveExpenseFn = saveExpense,
  deleteExpenseFn = deleteExpense,
  mainKeyboardFn = mainKeyboard,
  editMenuKeyboardFn = editMenuKeyboard,
  getActiveCardNamesFn = getActiveCardNames,
  getBillingMonthForPurchaseFn = getBillingMonthForPurchase,
  handleAnalysisCallback
} = {}) {
  return async function handleCallback(cb, { requestId } = {}) {
    const startedAt = Date.now();
    let status = "ok";
    let errorShort = null;
    let option = "callback";
    if (!cb?.message?.chat?.id) return;

    const chatId = String(cb.message.chat.id);
    const data = cb.data;

    try {
      if (data?.startsWith("ANALYSIS:") && typeof handleAnalysisCallback === "function") {
        option = "analysis_callback";
        const handled = await handleAnalysisCallback(cb, { requestId });
        if (handled) return;
      }

      // 🗑️ Confirmar borrado
      if (data === "delete_confirm") {
        option = "delete_confirm";
        const pendingDelete = getPendingDelete(chatId);
        if (!pendingDelete?.expenseId) {
          await sendMessage(chatId, "No tengo un borrado pendiente.");
          await answerCallback(cb.id);
          return;
        }

        const result = await deleteExpenseFn({
          chatId,
          pendingDelete,
          requestId: pendingDelete.requestId || requestId
        });
        if (result.ok) {
          clearPendingDelete(chatId);
        }

        await answerCallback(cb.id);
        return;
      }

      // ❌ Cancelar borrado
      if (data === "delete_cancel") {
        option = "delete_cancel";
        clearPendingDelete(chatId);
        await sendMessage(chatId, "Cancelado.");
        await answerCallback(cb.id);
        return;
      }

      // ❌ Cancelar
      if (data === "cancel") {
        option = "cancel";
        clearDraft(chatId);
        await sendMessage(chatId, "🧹 <b>Cancelado</b>.");
        await answerCallback(cb.id);
        return;
      }

      // ✅ Confirmar (normal o MSI)
      if (data === "confirm") {
        option = "confirm";
        const draft = getDraft(chatId);

        if (!draft) {
          await sendMessage(chatId, "No tengo borrador. Mándame un gasto primero.");
          await answerCallback(cb.id);
          return;
        }
        if (draft.is_msi && (!draft.msi_months || Number(draft.msi_months) <= 1)) {
          await sendMessage(
            chatId,
            "Faltan los meses MSI. Responde solo el número (ej: <code>6</code>)."
          );
          await answerCallback(cb.id);
          return;
        }
        if (!draft.payment_method) {
          await sendMessage(chatId, "Elige un método con botones o escribe cancelar.");
          await answerCallback(cb.id);
          return;
        }

        if (requestId) {
          draft.__perf = { ...draft.__perf, request_id: requestId };
        }

        const result = await saveExpenseFn({ chatId, draft });
        if (result.ok) {
          setLastExpenseId(chatId, result.expenseId);
          clearDraft(chatId);
        }

        await answerCallback(cb.id);
        return;
      }

      // ✏️ Menú editar
      if (data === "edit_menu") {
        option = "edit_menu";
        await sendMessage(chatId, "¿Qué quieres editar?", {
          reply_markup: editMenuKeyboardFn()
        });
        await answerCallback(cb.id);
        return;
      }

      // ⬅️ Volver al preview
      if (data === "back_preview") {
        option = "back_preview";
        const draft = getDraft(chatId);
        if (!draft) {
          await sendMessage(chatId, "No tengo borrador activo.");
        } else {
          await sendMessage(chatId, preview(draft), { reply_markup: mainKeyboardFn() });
        }
        await answerCallback(cb.id);
        return;
      }

      if (data?.startsWith("payment_method|")) {
        option = "payment_method";
        const draft = getDraft(chatId);
        if (!draft) {
          await sendMessage(chatId, "No tengo borrador. Mándame un gasto primero.");
          await answerCallback(cb.id);
          return;
        }

        const method = data.split("|").slice(1).join("|").trim();
        const activeCards = await getActiveCardNamesFn(chatId);
        const allowed = new Set([
          ...ALLOWED_PAYMENT_METHODS,
          ...(activeCards?.length ? activeCards : [])
        ]);

        if (!allowed.has(method)) {
          await sendMessage(chatId, "Método inválido. Elige uno de los botones.");
          await answerCallback(cb.id);
          return;
        }

        draft.payment_method = method;
        draft.__state = "ready_to_confirm";
        const messageId = cb.message?.message_id;
        if (requestId) {
          draft.__perf = { ...draft.__perf, request_id: requestId };
        }

        if (draft.is_msi && (!draft.msi_months || Number(draft.msi_months) <= 1)) {
          draft.__state = "awaiting_msi_months";
          setDraft(chatId, draft);
          const question =
            "🧾 Detecté <b>MSI</b>. ¿A cuántos meses? (responde solo el número, ej: <code>6</code>)";
          if (messageId) {
            await editMessage(chatId, messageId, question);
          } else {
            await sendMessage(chatId, question);
          }
          await answerCallback(cb.id);
          return;
        }

        if (draft.is_msi) {
          const cacheMeta = draft.__perf?.cache_hit || { card_rules: null, llm: null };
          draft.__perf = { ...draft.__perf, cache_hit: cacheMeta };

          draft.msi_start_month = await getBillingMonthForPurchaseFn({
            chatId,
            cardName: draft.payment_method,
            purchaseDateISO: draft.purchase_date,
            cacheMeta
          });
        }

        const err = validateDraft(draft);
        if (err) {
          await sendMessage(chatId, err);
          await answerCallback(cb.id);
          return;
        }

        if (messageId) {
          await editMessage(chatId, messageId, preview(draft), {
            reply_markup: mainKeyboardFn()
          });
        } else {
          await sendMessage(chatId, preview(draft), { reply_markup: mainKeyboardFn() });
        }
        await answerCallback(cb.id);
        return;
      }

      await answerCallback(cb.id);
    } catch (error) {
      status = "error";
      errorShort = shortError(error);
      throw error;
    } finally {
      const totalMs = Date.now() - startedAt;
      logPerf(
        {
          request_id: requestId || null,
          flow: "callback",
          option,
          chat_id: chatId,
          bq_ms: 0,
          llm_ms: 0,
          total_ms: totalMs,
          status,
          error: errorShort || undefined
        },
        status === "error" ? "warn" : "log"
      );
    }
  };
}

import {
  mainKeyboard,
  editMenuKeyboard,
  tgSend,
  answerCallbackQuery,
  tgEditMessage
} from "../telegram.js";
import { preview, validateDraft } from "../parsing.js";
import { applyDraftAction } from "finclaro-core";
import {
  getDraft,
  setDraft,
  clearDraft,
  getPendingDelete,
  clearPendingDelete,
  setLastExpenseId,
  getLedgerDraft,
  setLedgerDraft,
  clearLedgerDraft
} from "../state.js";
import { saveExpense } from "../usecases/save_expense.js";
import { deleteExpense } from "../usecases/delete_expense.js";
import {
  getActiveCardNames,
  getBillingMonthForPurchase,
  insertLedgerMovement
} from "../storage/bigquery.js";
import { ALLOWED_PAYMENT_METHODS } from "../config.js";
import {
  buildAccountSelectKeyboard,
  buildConfirmKeyboard,
  formatMovementPreview,
  validateMovementDraft
} from "../ledger.js";

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
  insertLedgerMovementFn = insertLedgerMovement,
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
    const logLedgerPerf = (payload, level = "log") => {
      logPerf(
        {
          request_id: requestId || null,
          flow: "ledger",
          chat_id: chatId,
          ...payload
        },
        level
      );
    };

    try {
      if (data?.startsWith("ANALYSIS:") && typeof handleAnalysisCallback === "function") {
        option = "analysis_callback";
        const handled = await handleAnalysisCallback(cb, { requestId });
        if (handled) return;
      }

      if (data === "ledger_cancel") {
        option = "ledger_cancel";
        clearLedgerDraft(chatId);
        await sendMessage(chatId, "🧹 <b>Movimiento cancelado</b>.");
        await answerCallback(cb.id);
        logLedgerPerf({
          subtype: "movement_cancel",
          bq_ms: 0,
          total_ms: Date.now() - startedAt,
          status: "ok"
        });
        return;
      }

      if (data === "ledger_confirm") {
        option = "ledger_confirm";
        const ledgerDraft = getLedgerDraft(chatId);
        if (!ledgerDraft) {
          await sendMessage(chatId, "No tengo un movimiento pendiente.");
          await answerCallback(cb.id);
          return;
        }

        const validationError = validateMovementDraft(ledgerDraft);
        if (validationError) {
          await sendMessage(chatId, validationError);
          await answerCallback(cb.id);
          return;
        }

        const bqStart = Date.now();
        try {
          const movementId = await insertLedgerMovementFn(ledgerDraft, chatId);
          const bqMs = Date.now() - bqStart;
          clearLedgerDraft(chatId);
          await sendMessage(
            chatId,
            `✅ Movimiento guardado. ID: <code>${movementId}</code>`
          );
          await answerCallback(cb.id);
          logLedgerPerf({
            subtype: "movement_confirm",
            bq_ms: bqMs,
            total_ms: Date.now() - startedAt,
            status: "ok"
          });
          return;
        } catch (error) {
          const bqMs = Date.now() - bqStart;
          logLedgerPerf(
            {
              subtype: "movement_confirm",
              bq_ms: bqMs,
              total_ms: Date.now() - startedAt,
              status: "error",
              error: shortError(error)
            },
            "warn"
          );
          throw error;
        }
      }

      if (data?.startsWith("ledger_select|")) {
        option = "ledger_select";
        const ledgerDraft = getLedgerDraft(chatId);
        if (!ledgerDraft?.__pending) {
          await sendMessage(chatId, "No tengo selección pendiente.");
          await answerCallback(cb.id);
          return;
        }

        const [, field, accountId] = data.split("|");
        const pending = ledgerDraft.__pending;
        const selected = pending.options?.find(
          (optionItem) => optionItem.account_id === accountId
        );
        if (!selected) {
          await sendMessage(chatId, "Selección inválida.");
          await answerCallback(cb.id);
          return;
        }

        if (field === "from") {
          ledgerDraft.from_account_id = selected.account_id;
          ledgerDraft.from_account_label = selected.label;
        } else {
          ledgerDraft.to_account_id = selected.account_id;
          ledgerDraft.to_account_label = selected.label;
        }

        if (ledgerDraft.__pending_next) {
          ledgerDraft.__pending = ledgerDraft.__pending_next;
          ledgerDraft.__pending_next = null;
          setLedgerDraft(chatId, ledgerDraft);
          const fieldLabel = ledgerDraft.__pending.field === "from" ? "origen" : "destino";
          await sendMessage(chatId, `Selecciona la cuenta de ${fieldLabel}:`, {
            reply_markup: buildAccountSelectKeyboard(
              ledgerDraft.__pending.options,
              ledgerDraft.__pending.field
            )
          });
          await answerCallback(cb.id);
          logLedgerPerf({
            subtype: "movement_select_account",
            bq_ms: 0,
            total_ms: Date.now() - startedAt,
            status: "ok"
          });
          return;
        }

        ledgerDraft.__pending = null;
        setLedgerDraft(chatId, ledgerDraft);
        await sendMessage(chatId, formatMovementPreview(ledgerDraft), {
          reply_markup: buildConfirmKeyboard()
        });
        await answerCallback(cb.id);
        logLedgerPerf({
          subtype: "movement_preview",
          bq_ms: 0,
          total_ms: Date.now() - startedAt,
          status: "ok"
        });
        return;
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

      if (data === "trip_exclude" || data === "trip_include") {
        option = data;
        const draft = getDraft(chatId);

        if (!draft) {
          await sendMessage(chatId, "No tengo borrador. Mándame un gasto primero.");
          await answerCallback(cb.id);
          return;
        }

        const toggled = applyDraftAction(draft, {
          type: "toggleTripInclude",
          include: data === "trip_include"
        }).draft;

        setDraft(chatId, toggled);
        const messageId = cb.message?.message_id;
        if (messageId) {
          await editMessage(chatId, messageId, preview(toggled), {
            reply_markup: mainKeyboardFn(toggled)
          });
        } else {
          await sendMessage(chatId, preview(toggled), { reply_markup: mainKeyboardFn(toggled) });
        }

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
          await sendMessage(chatId, preview(draft), { reply_markup: mainKeyboardFn(draft) });
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

        const selected = applyDraftAction(draft, {
          type: "selectPaymentMethod",
          method
        }).draft;
        const messageId = cb.message?.message_id;
        if (requestId) {
          selected.__perf = { ...selected.__perf, request_id: requestId };
        }

        if (selected.is_msi && (!selected.msi_months || Number(selected.msi_months) <= 1)) {
          selected.__state = "awaiting_msi_months";
          setDraft(chatId, selected);
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

        if (selected.is_msi) {
          const cacheMeta = selected.__perf?.cache_hit || { card_rules: null, llm: null };
          selected.__perf = { ...selected.__perf, cache_hit: cacheMeta };

          selected.msi_start_month = await getBillingMonthForPurchaseFn({
            chatId,
            cardName: selected.payment_method,
            purchaseDateISO: selected.purchase_date,
            cacheMeta
          });
        }

        const err = validateDraft(selected);
        if (err) {
          await sendMessage(chatId, err);
          await answerCallback(cb.id);
          return;
        }

        setDraft(chatId, selected);
        if (messageId) {
          await editMessage(chatId, messageId, preview(selected), {
            reply_markup: mainKeyboardFn(selected)
          });
        } else {
          await sendMessage(chatId, preview(selected), { reply_markup: mainKeyboardFn(selected) });
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

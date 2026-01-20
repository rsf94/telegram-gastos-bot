import { mainKeyboard, editMenuKeyboard, tgSend, answerCallbackQuery } from "../telegram.js";
import { preview } from "../parsing.js";
import {
  getDraft,
  clearDraft,
  getPendingDelete,
  clearPendingDelete
} from "../state.js";
import { saveExpense } from "../usecases/save_expense.js";
import { deleteExpense } from "../usecases/delete_expense.js";

export function createCallbackHandler({
  sendMessage = tgSend,
  answerCallback = answerCallbackQuery,
  saveExpenseFn = saveExpense,
  deleteExpenseFn = deleteExpense,
  mainKeyboardFn = mainKeyboard,
  editMenuKeyboardFn = editMenuKeyboard
} = {}) {
  return async function handleCallback(cb) {
    if (!cb?.message?.chat?.id) return;

    const chatId = String(cb.message.chat.id);
    const data = cb.data;

    // 🗑️ Confirmar borrado
    if (data === "delete_confirm") {
      const pendingDelete = getPendingDelete(chatId);
      if (!pendingDelete?.expenseId) {
        await sendMessage(chatId, "No tengo un borrado pendiente.");
        await answerCallback(cb.id);
        return;
      }

      const result = await deleteExpenseFn({ chatId, pendingDelete });
      if (result.ok) {
        clearPendingDelete(chatId);
      }

      await answerCallback(cb.id);
      return;
    }

    // ❌ Cancelar borrado
    if (data === "delete_cancel") {
      clearPendingDelete(chatId);
      await sendMessage(chatId, "Cancelado.");
      await answerCallback(cb.id);
      return;
    }

    // ❌ Cancelar
    if (data === "cancel") {
      clearDraft(chatId);
      await sendMessage(chatId, "🧹 <b>Cancelado</b>.");
      await answerCallback(cb.id);
      return;
    }

    // ✅ Confirmar (normal o MSI)
    if (data === "confirm") {
      const draft = getDraft(chatId);

      if (!draft) {
        await sendMessage(chatId, "No tengo borrador. Mándame un gasto primero.");
        await answerCallback(cb.id);
        return;
      }

      const result = await saveExpenseFn({ chatId, draft });
      if (result.ok) {
        clearDraft(chatId);
      }

      await answerCallback(cb.id);
      return;
    }

    // ✏️ Menú editar
    if (data === "edit_menu") {
      await sendMessage(chatId, "¿Qué quieres editar?", { reply_markup: editMenuKeyboardFn() });
      await answerCallback(cb.id);
      return;
    }

    // ⬅️ Volver al preview
    if (data === "back_preview") {
      const draft = getDraft(chatId);
      if (!draft) {
        await sendMessage(chatId, "No tengo borrador activo.");
      } else {
        await sendMessage(chatId, preview(draft), { reply_markup: mainKeyboardFn() });
      }
      await answerCallback(cb.id);
      return;
    }

    await answerCallback(cb.id);
  };
}

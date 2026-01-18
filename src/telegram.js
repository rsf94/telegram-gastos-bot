import { TELEGRAM_BOT_TOKEN } from "./config.js";

/* =======================
 * Helpers
 * ======================= */
export function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/* =======================
 * Telegram send helpers
 * ======================= */
export async function tgSend(chatId, text, extra = {}) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...extra
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram sendMessage failed ${res.status}: ${body}`);
  }
}

export async function answerCallbackQuery(callbackQueryId) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId })
  });
}

/* =======================
 * Keyboards
 * ======================= */

/**
 * Teclado principal debajo del preview
 * ✏️ Editar
 * ✅ Confirmar | ❌ Cancelar
 */
export function mainKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "✏️ Editar", callback_data: "edit_menu" }],
      [
        { text: "✅ Confirmar", callback_data: "confirm" },
        { text: "❌ Cancelar", callback_data: "cancel" }
      ]
    ]
  };
}

/**
 * Menú de edición
 */
export function editMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📅 Cambiar fecha", callback_data: "edit_date" }],
      [{ text: "🏷 Cambiar categoría", callback_data: "edit_category" }],
      [{ text: "💳 Cambiar método", callback_data: "edit_payment" }],
      [{ text: "⬅️ Volver", callback_data: "back_preview" }]
    ]
  };
}

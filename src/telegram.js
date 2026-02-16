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

export async function tgEditMessage(chatId, messageId, text, extra = {}) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;
  const payload = {
    chat_id: chatId,
    message_id: messageId,
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
    throw new Error(`Telegram editMessageText failed ${res.status}: ${body}`);
  }
}

/* =======================
 * Keyboards
 * ======================= */

/**
 * Teclado principal debajo del preview
 * ✏️ Editar
 * ✅ Confirmar | ❌ Cancelar
 */
export function mainKeyboard(draft = null) {
  const rows = [[{ text: "✏️ Editar", callback_data: "edit_menu" }]];
  const hasActiveTrip = Boolean(draft?.active_trip_id);
  if (hasActiveTrip && draft?.trip_id) {
    rows.push([{ text: "🚫 No es del viaje", callback_data: "trip_exclude" }]);
  } else if (hasActiveTrip) {
    rows.push([{ text: "↩️ Sí es del viaje", callback_data: "trip_include" }]);
  }

  rows.push([
    { text: "✅ Confirmar", callback_data: "confirm" },
    { text: "❌ Cancelar", callback_data: "cancel" }
  ]);

  return {
    inline_keyboard: rows
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

export function paymentMethodKeyboard(methods) {
  const rows = [];
  const list = Array.isArray(methods) ? methods : [];

  for (let i = 0; i < list.length; i += 2) {
    const row = [];
    const left = list[i];
    const right = list[i + 1];
    if (left) row.push({ text: left, callback_data: `payment_method|${left}` });
    if (right) row.push({ text: right, callback_data: `payment_method|${right}` });
    if (row.length) rows.push(row);
  }

  rows.push([{ text: "❌ Cancelar", callback_data: "cancel" }]);
  return { inline_keyboard: rows };
}

/**
 * Confirmación de borrado
 */
export function deleteConfirmKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "✅ Confirmar borrado", callback_data: "delete_confirm" },
        { text: "❌ Cancelar", callback_data: "delete_cancel" }
      ]
    ]
  };
}

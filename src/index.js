// index.js
import express from "express";

import { warnMissingEnv, ALLOWED_PAYMENT_METHODS } from "./config.js";
import {
  tgSend,
  mainKeyboard,
  editMenuKeyboard,
  answerCallbackQuery,
  escapeHtml
} from "./telegram.js";
import { insertExpenseAndMaybeInstallments } from "./storage/bigquery.js";
import { callDeepSeekParse, validateParsedFromAI } from "./deepseek.js";
import { naiveParse, validateDraft, overrideRelativeDate, preview } from "./parsing.js";
import { runDailyCardReminders } from "./reminders.js";

warnMissingEnv();

const app = express();
app.use(express.json({ limit: "1mb" }));

// Draft store (MVP)
const draftByChat = new Map(); // chatId -> draft

/* =======================
 * Helpers
 * ======================= */
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}
function monthStartISO(yyyyMmDd) {
  return `${String(yyyyMmDd).slice(0, 7)}-01`;
}
function looksLikeMsiText(text) {
  // ✅ FIX: esto sí detecta "6msi", "msi", "6 msi", etc.
  const t = String(text || "").toLowerCase();
  return t.includes("msi") || /meses?\s+sin\s+intereses?/.test(t);
}
function parseJustMonths(text) {
  // Acepta "6", "6 meses", "a 6", "6 msi"
  const t = String(text || "").toLowerCase().trim();
  const m = t.match(/(\d{1,2})/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 1 || n > 60) return null;
  return n;
}

app.get("/", (req, res) => res.status(200).send("OK"));

app.post("/telegram-webhook", async (req, res) => {
  res.status(200).send("ok");

  try {
    const update = req.body;

    // 1) callbacks (botones)
    const cb = update.callback_query;
    if (cb?.message?.chat?.id) {
      const chatId = String(cb.message.chat.id);
      const data = cb.data;

      if (data === "cancel") {
        draftByChat.delete(chatId);
        await tgSend(chatId, "🧹 <b>Cancelado</b>.");
        await answerCallbackQuery(cb.id);
        return;
      }

      if (data === "confirm") {
        const draft = draftByChat.get(chatId);
        if (!draft) {
          await tgSend(chatId, "No tengo borrador. Mándame un gasto primero.");
        } else if (draft.__state === "awaiting_msi_months") {
          await tgSend(chatId, "Primero dime a cuántos meses es el MSI (ej: <code>6</code>).");
        } else {
          const expenseId = await insertExpenseAndMaybeInstallments(draft, chatId);
          draftByChat.delete(chatId);
          await tgSend(
            chatId,
            `✅ <b>Guardado</b> en BigQuery.\nID: <code>${escapeHtml(expenseId)}</code>`
          );
        }
        await answerCallbackQuery(cb.id);
        return;
      }

      if (data === "edit_menu") {
        await tgSend(chatId, "¿Qué quieres editar?", { reply_markup: editMenuKeyboard() });
        await answerCallbackQuery(cb.id);
        return;
      }

      if (data === "back_preview") {
        const draft = draftByChat.get(chatId);
        if (!draft) {
          await tgSend(chatId, "No tengo borrador activo.");
        } else {
          await tgSend(chatId, preview(draft), { reply_markup: mainKeyboard() });
        }
        await answerCallbackQuery(cb.id);
        return;
      }

      await answerCallbackQuery(cb.id);
      return;
    }

    // 2) mensajes
    const msg = update.message || update.edited_message;
    if (!msg?.chat?.id) return;

    const chatId = String(msg.chat.id);
    const text = (msg.text || "").trim();

    if (!text) {
      await tgSend(
        chatId,
        '✅ conectado. Mándame un gasto como: <b>230</b> Uber American Express ayer\n(Escribe <b>ayuda</b> para ejemplos)'
      );
      return;
    }

    const low = text.toLowerCase();

    if (low === "ayuda" || low === "/help") {
      await tgSend(
        chatId,
        [
          "🧾 <b>Envíame un gasto</b>. Ej:",
          "<code>230 Uber American Express ayer</code>",
          "",
          "🧾 <b>MSI</b>. Ej:",
          "<code>gasolina 1200 BBVA Platino a MSI</code>",
          "y luego respondes sólo: <code>6</code>",
          "",
          "Luego confirma con botón ✅ o escribe <b>confirmar</b>.",
          "",
          "<b>Métodos válidos:</b>",
          ALLOWED_PAYMENT_METHODS.map((x) => `- ${escapeHtml(x)}`).join("\n"),
          "",
          "Nota: <b>'Amex'</b> a secas es ambiguo."
        ].join("\n")
      );
      return;
    }

    if (low === "cancelar" || low === "/cancel") {
      draftByChat.delete(chatId);
      await tgSend(chatId, "🧹 <b>Cancelado</b>.");
      return;
    }

    // ✅ FIX: no dejes "confirmar" si estás esperando meses
    const existing0 = draftByChat.get(chatId);
    if ((low === "confirmar" || low === "/confirm") && existing0?.__state === "awaiting_msi_months") {
      await tgSend(chatId, "Primero dime a cuántos meses es el MSI (ej: <code>6</code>).");
      return;
    }

    if (low === "confirmar" || low === "/confirm") {
      const draft = draftByChat.get(chatId);
      if (!draft) {
        await tgSend(chatId, "No tengo borrador. Mándame un gasto primero.");
        return;
      }
      const expenseId = await insertExpenseAndMaybeInstallments(draft, chatId);
      draftByChat.delete(chatId);
      await tgSend(
        chatId,
        `✅ <b>Guardado</b> en BigQuery.\nID: <code>${escapeHtml(expenseId)}</code>`
      );
      return;
    }

    // =========================
    // FLUJO A: "Esperando meses" (MSI step 2)
    // =========================
    const existing = draftByChat.get(chatId);
    if (existing?.__state === "awaiting_msi_months") {
      const n = parseJustMonths(text);
      if (!n) {
        await tgSend(chatId, "Dime solo el número de meses (ej: <code>6</code>, <code>12</code>).");
        return;
      }

      existing.is_msi = true;
      existing.msi_months = n;

      // Si no existe total, usa lo que haya en amount_mxn como total (por seguridad)
      if (!existing.msi_total_amount || Number(existing.msi_total_amount) <= 0) {
        existing.msi_total_amount = Number(existing.msi_total_amount || existing.amount_mxn);
      }

      // start_month default al mes de compra
      existing.msi_start_month = existing.msi_start_month || monthStartISO(existing.purchase_date);

      // amount_mxn = mensual (cashflow)
      existing.amount_mxn = round2(Number(existing.msi_total_amount) / n);

      // ya no estamos esperando
      delete existing.__state;

      draftByChat.set(chatId, existing);
      await tgSend(chatId, preview(existing), { reply_markup: mainKeyboard() });
      return;
    }

    // =========================
    // Detecta si es MSI (FLUJO B) o normal (FLUJO C)
    // =========================
    const wantsMsi = looksLikeMsiText(text);

    // =========================
    // FLUJO B: MSI (step 1)
    // =========================
    if (wantsMsi) {
      let draft = null;

      // 1) intentar IA (si regresa ok, usamos draft; si pide meses, igual usamos draft)
      try {
        const parsed = await callDeepSeekParse(text);
        const v = await validateParsedFromAI(parsed);

        if (v.ok && v.draft) {
          draft = v.draft;
        } else if (v.needs_msi_months && v.draft) {
          draft = v.draft;
        }
      } catch (e) {
        draft = null;
      }

      // 2) fallback naive si no hay draft usable
      if (!draft) {
        draft = naiveParse(text);
        draft.purchase_date = overrideRelativeDate(text, draft.purchase_date);
        const err = validateDraft(draft);
        if (err) {
          await tgSend(chatId, err);
          return;
        }
      }

      // 3) fija MSI incompleto (en MSI, el monto del texto es TOTAL)
      draft.raw_text = text;
      draft.purchase_date = overrideRelativeDate(text, draft.purchase_date);

      draft.is_msi = true;
      draft.msi_total_amount = Number(draft.msi_total_amount || draft.amount_mxn);
      draft.msi_months = null;
      draft.msi_start_month = monthStartISO(draft.purchase_date);

      // estado: esperando meses
      draft.__state = "awaiting_msi_months";

      draftByChat.set(chatId, draft);
      await tgSend(
        chatId,
        "🧾 Detecté <b>MSI</b>. ¿A cuántos meses? (responde solo el número, ej: <code>6</code>)"
      );
      return;
    }

    // =========================
    // FLUJO C: normal (sin MSI)
    // =========================
    if (!/\d/.test(text)) {
      await tgSend(
        chatId,
        '✅ conectado. Mándame un gasto como: <b>230</b> Uber American Express ayer\n(Escribe <b>ayuda</b> para ejemplos)'
      );
      return;
    }

    let draft;
    try {
      const parsed = await callDeepSeekParse(text);
      const v = await validateParsedFromAI(parsed);

      if (!v.ok) {
        await tgSend(chatId, `❌ ${escapeHtml(v.error)}`);
        return;
      }

      draft = v.draft;
      draft.raw_text = text;
      draft.purchase_date = overrideRelativeDate(text, draft.purchase_date);
    } catch (e) {
      console.error("DeepSeek parse failed, fallback naive:", e);

      draft = naiveParse(text);
      draft.raw_text = text;
      draft.purchase_date = overrideRelativeDate(text, draft.purchase_date);

      const err = validateDraft(draft);
      if (err) {
        await tgSend(chatId, err);
        return;
      }
    }

    // asegúrate que NO sea MSI
    draft.is_msi = false;
    draft.msi_months = null;
    draft.msi_total_amount = null;
    draft.msi_start_month = null;

    draftByChat.set(chatId, draft);
    await tgSend(chatId, preview(draft), { reply_markup: mainKeyboard() });
  } catch (e) {
    console.error(e);
  }
});

// ===== CRON: recordatorios (corte/pago) =====
app.get("/cron/daily", async (req, res) => {
  try {
    const token = String(req.query.token || "");
    if (!process.env.CRON_TOKEN || token !== process.env.CRON_TOKEN) {
      return res.status(401).send("unauthorized");
    }

    const force = String(req.query.force || "") === "1";
    await runDailyCardReminders({ force });

    return res.status(200).send("ok");
  } catch (e) {
    console.error(e);
    return res.status(500).send("error");
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`listening on ${PORT}`));

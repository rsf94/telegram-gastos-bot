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
import {
  naiveParse,
  validateDraft,
  overrideRelativeDate,
  preview
} from "./parsing.js";
import { runDailyCardReminders } from "./reminders.js";

warnMissingEnv();

const app = express();
app.use(express.json({ limit: "1mb" }));

// Draft store (MVP)
const draftByChat = new Map(); // chatId -> draft

/* =======================
 * Helpers (para MSI)
 * ======================= */
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function monthStartISO(yyyyMmDd) {
  return `${String(yyyyMmDd).slice(0, 7)}-01`; // YYYY-MM-01
}

function isJustMonthsNumber(text) {
  return /^[0-9]{1,2}$/.test(String(text || "").trim()); // 1..99
}

app.get("/", (req, res) => res.status(200).send("OK"));

app.post("/telegram-webhook", async (req, res) => {
  // Responder rápido a Telegram
  res.status(200).send("ok");

  try {
    const update = req.body;

    // 1) callbacks (botones)
    const cb = update.callback_query;
    if (cb?.message?.chat?.id) {
      const chatId = String(cb.message.chat.id);
      const data = cb.data;

      // ❌ Cancelar
      if (data === "cancel") {
        draftByChat.delete(chatId);
        await tgSend(chatId, "🧹 <b>Cancelado</b>.");
        await answerCallbackQuery(cb.id);
        return;
      }

      // ✅ Confirmar
      if (data === "confirm") {
        const draft = draftByChat.get(chatId);
        if (!draft) {
          await tgSend(chatId, "No tengo borrador. Mándame un gasto primero.");
        } else {
          // Si era MSI y aún faltan meses, pedirlos
          if (draft.is_msi === true && (!draft.msi_months || Number(draft.msi_months) <= 1)) {
            await tgSend(chatId, "🧾 Detecté <b>MSI</b>. ¿A cuántos meses? (ej: <code>6</code>)");
            await answerCallbackQuery(cb.id);
            return;
          }

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

      // ✏️ Menú editar
      if (data === "edit_menu") {
        await tgSend(chatId, "¿Qué quieres editar?", {
          reply_markup: editMenuKeyboard()
        });
        await answerCallbackQuery(cb.id);
        return;
      }

      // ⬅️ Volver al preview
      if (data === "back_preview") {
        const draft = draftByChat.get(chatId);
        if (!draft) {
          await tgSend(chatId, "No tengo borrador activo.");
        } else {
          await tgSend(chatId, preview(draft), {
            reply_markup: mainKeyboard()
          });
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

    if (low === "confirmar" || low === "/confirm") {
      const draft = draftByChat.get(chatId);
      if (!draft) {
        await tgSend(chatId, "No tengo borrador. Mándame un gasto primero.");
        return;
      }

      // Si era MSI y aún faltan meses, pedirlos
      if (draft.is_msi === true && (!draft.msi_months || Number(draft.msi_months) <= 1)) {
        await tgSend(chatId, "🧾 Detecté <b>MSI</b>. ¿A cuántos meses? (ej: <code>6</code>)");
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

    // ===============================
    // MSI STEP: si estamos esperando SOLO el número de meses, NO llames a DeepSeek
    // ===============================
    const existing = draftByChat.get(chatId);
    if (
      existing?.is_msi === true &&
      (!existing.msi_months || Number(existing.msi_months) <= 1) &&
      isJustMonthsNumber(text)
    ) {
      const n = Number(text.trim());

      if (!Number.isFinite(n) || n <= 1 || n > 60) {
        await tgSend(
          chatId,
          "Dime solo el número de meses (ej: <code>6</code>, <code>12</code>)."
        );
        return;
      }

      existing.msi_months = n;

      // total MSI
      if (!existing.msi_total_amount || Number(existing.msi_total_amount) <= 0) {
        existing.msi_total_amount = Number(existing.amount_mxn); // fallback
      }

      // start month MSI
      existing.msi_start_month =
        existing.msi_start_month || monthStartISO(existing.purchase_date);

      // cashflow mensual
      existing.amount_mxn = round2(Number(existing.msi_total_amount) / n);

      draftByChat.set(chatId, existing);
      await tgSend(chatId, preview(existing), { reply_markup: mainKeyboard() });
      return;
    }

    // Si no tiene dígitos y no era MSI-step, manda hint
    if (!/\d/.test(text)) {
      await tgSend(
        chatId,
        '✅ conectado. Mándame un gasto como: <b>230</b> Uber American Express ayer\n(Escribe <b>ayuda</b> para ejemplos)'
      );
      return;
    }

    // Parse IA + fallback
    let draft;

    try {
      const parsed = await callDeepSeekParse(text);
      const v = await validateParsedFromAI(parsed);

      if (!v.ok) {
        // Si tu validateParsedFromAI implementa “needs_msi_months”, lo soportamos:
        if (v.needs_msi_months && v.draft) {
          const partial = {
            ...v.draft,
            raw_text: text,
            // por si acaso
            is_msi: true,
            msi_months: null
          };

          // aplica override de fecha si venía relativa
          if (partial.purchase_date) {
            partial.purchase_date = overrideRelativeDate(text, partial.purchase_date);
          }

          draftByChat.set(chatId, partial);
          await tgSend(
            chatId,
            "🧾 Detecté <b>MSI</b>. ¿A cuántos meses? (ej: <code>6</code>)"
          );
          return;
        }

        await tgSend(chatId, `❌ ${escapeHtml(v.error)}`);
        return;
      }

      draft = v.draft;
      draft.raw_text = text;
      draft.purchase_date = overrideRelativeDate(text, draft.purchase_date);
    } catch (e) {
      console.error("DeepSeek parse failed, fallback naive:", e);

      draft = naiveParse(text);
      draft.raw_text = text

      draft.purchase_date = overrideRelativeDate(text, draft.purchase_date);

      const err = validateDraft(draft);
      if (err) {
        await tgSend(chatId, err);
        return;
      }
    }

    draftByChat.set(chatId, draft);

    // Si detectaste MSI pero no meses (por cualquier razón), pregunta antes de preview-confirm
    if (draft?.is_msi === true && (!draft.msi_months || Number(draft.msi_months) <= 1)) {
      await tgSend(
        chatId,
        "🧾 Detecté <b>MSI</b>. ¿A cuántos meses? (ej: <code>6</code>)"
      );
      return;
    }

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

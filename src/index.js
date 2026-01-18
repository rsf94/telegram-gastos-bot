import express from "express";

import { warnMissingEnv, ALLOWED_PAYMENT_METHODS } from "./config.js";
import { tgSend, mainKeyboard, answerCallbackQuery, escapeHtml } from "./telegram.js";
import { insertExpenseToBQ } from "./storage/bigquery.js";
import { callDeepSeekParse, validateParsedFromAI } from "./deepseek.js";
import { naiveParse, validateDraft, overrideRelativeDate, preview } from "./parsing.js";

warnMissingEnv();

const app = express();
app.use(express.json({ limit: "1mb" }));

// Draft store (MVP)
const draftByChat = new Map(); // chatId -> draft

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
      } else if (data === "confirm") {
        const draft = draftByChat.get(chatId);
        if (!draft) {
          await tgSend(chatId, "No tengo borrador. Mándame un gasto primero.");
        } else {
          const expenseId = await insertExpenseToBQ(draft, chatId);
          draftByChat.delete(chatId);
          await tgSend(chatId, `✅ <b>Guardado</b> en BigQuery.\nID: <code>${escapeHtml(expenseId)}</code>`);
        }
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
      await tgSend(chatId, '✅ conectado. Mándame un gasto como: <b>230</b> Uber American Express ayer\n(Escribe <b>ayuda</b> para ejemplos)');
      return;
    }

    const low = text.toLowerCase();

    if (low === "ayuda" || low === "/help") {
      await tgSend(chatId, [
        "🧾 <b>Envíame un gasto</b>. Ej:",
        "<code>230 Uber American Express ayer</code>",
        "",
        "Luego confirma con botón ✅ o escribe <b>confirmar</b>.",
        "",
        "<b>Métodos válidos:</b>",
        ALLOWED_PAYMENT_METHODS.map(x => `- ${escapeHtml(x)}`).join("\n"),
        "",
        "Nota: <b>'Amex'</b> a secas es ambiguo."
      ].join("\n"));
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
      const expenseId = await insertExpenseToBQ(draft, chatId);
      draftByChat.delete(chatId);
      await tgSend(chatId, `✅ <b>Guardado</b> en BigQuery.\nID: <code>${escapeHtml(expenseId)}</code>`);
      return;
    }

    if (!/\d/.test(text)) {
      await tgSend(chatId, '✅ conectado. Mándame un gasto como: <b>230</b> Uber American Express ayer\n(Escribe <b>ayuda</b> para ejemplos)');
      return;
    }

    // Parse IA + fallback
    let draft;

    try {
      const parsed = await callDeepSeekParse(text);
      const v = validateParsedFromAI(parsed);

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

    draftByChat.set(chatId, draft);
    await tgSend(chatId, preview(draft), { reply_markup: mainKeyboard() });

  } catch (e) {
    console.error(e);
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`listening on ${PORT}`));

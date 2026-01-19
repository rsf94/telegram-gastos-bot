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
import { callDeepSeekComplete } from "./deepseek.js";
import {
  localParseExpense,
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
 * Helpers
 * ======================= */
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function monthStartISO(yyyyMmDd) {
  return `${String(yyyyMmDd).slice(0, 7)}-01`;
}

function looksLikeMsiText(text) {
  const t = String(text || "").toLowerCase();
  // cubre: "msi", "a msi", "6msi", "6 msi", "meses sin intereses"
  return (
    /\bmsi\b/.test(t) ||
    /\bmeses?\s+sin\s+intereses?\b/.test(t) ||
    /\d+\s*msi\b/.test(t)
  );
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

let deepSeekCalls = 0;

function hasClassificationContext(draft) {
  const desc = String(draft.description || "").trim();
  return desc && desc.toLowerCase() !== "gasto";
}

function shouldCallDeepSeek(draft) {
  const missingAmount = !isFinite(draft.amount_mxn) || draft.amount_mxn <= 0;
  const missingPayment = !draft.payment_method;
  const missingDate = !draft.purchase_date;
  const missingRequired = missingAmount || missingPayment || missingDate;

  const needsCategory =
    !missingRequired && draft.category === "Other" && hasClassificationContext(draft);

  const complex = draft.__meta?.has_multiple_amounts === true;

  return missingRequired || needsCategory || complex;
}

function buildCompletionBase(draft) {
  const base = {
    amount_mxn: isFinite(draft.amount_mxn) && draft.amount_mxn > 0 ? draft.amount_mxn : null,
    payment_method: draft.payment_method || null,
    category: draft.category !== "Other" ? draft.category : null,
    purchase_date: draft.purchase_date || null,
    merchant: draft.merchant || null,
    description:
      draft.description && draft.description.toLowerCase() !== "gasto"
        ? draft.description
        : null
  };

  return base;
}

function mergeLocalAndAI(local, ai) {
  const merged = { ...local };

  if (ai && typeof ai === "object") {
    if (!isFinite(merged.amount_mxn) || merged.amount_mxn <= 0) {
      const amount = Number(ai.amount_mxn);
      if (Number.isFinite(amount) && amount > 0) merged.amount_mxn = amount;
    }

    if (!merged.payment_method && typeof ai.payment_method === "string") {
      merged.payment_method = ai.payment_method.trim();
    }

    if (
      (!merged.purchase_date || !/^\d{4}-\d{2}-\d{2}$/.test(merged.purchase_date)) &&
      typeof ai.purchase_date === "string"
    ) {
      merged.purchase_date = ai.purchase_date.trim();
    }

    if (merged.category === "Other" && typeof ai.category === "string") {
      merged.category = ai.category.trim();
    }

    if (!merged.merchant && typeof ai.merchant === "string") {
      merged.merchant = ai.merchant.trim();
    }

    if (
      (!merged.description || merged.description.toLowerCase() === "gasto") &&
      typeof ai.description === "string"
    ) {
      merged.description = ai.description.trim();
    }
  }

  return merged;
}

/* =======================
 * Routes
 * ======================= */
app.get("/", (req, res) => res.status(200).send("OK"));

app.post("/telegram-webhook", async (req, res) => {
  res.status(200).send("ok");

  try {
    const update = req.body;

    // =========================
    // 1) callbacks (botones)
    // =========================
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

      // ✅ Confirmar (normal o MSI)
      if (data === "confirm") {
        const draft = draftByChat.get(chatId);

        if (!draft) {
          await tgSend(chatId, "No tengo borrador. Mándame un gasto primero.");
          await answerCallbackQuery(cb.id);
          return;
        }

        try {
          const expenseId = await insertExpenseAndMaybeInstallments(draft, chatId);
          draftByChat.delete(chatId);

          await tgSend(
            chatId,
            `✅ <b>Guardado</b>\nID: <code>${escapeHtml(expenseId)}</code>`
          );
        } catch (e) {
          logBigQueryError(e);
          const pretty = formatBigQueryError(e);
          await tgSend(chatId, `❌ <b>No se pudo guardar</b>\n${escapeHtml(pretty)}`);
        }

        await answerCallbackQuery(cb.id);
        return;
      }

      // ✏️ Menú editar
      if (data === "edit_menu") {
        await tgSend(chatId, "¿Qué quieres editar?", { reply_markup: editMenuKeyboard() });
        await answerCallbackQuery(cb.id);
        return;
      }

      // ⬅️ Volver al preview
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

    // =========================
    // 2) mensajes
    // =========================
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

    if (low === "confirmar" || low === "/confirm") {
      const draft = draftByChat.get(chatId);
      if (!draft) {
        await tgSend(chatId, "No tengo borrador. Mándame un gasto primero.");
        return;
      }

      try {
        const expenseId = await insertExpenseAndMaybeInstallments(draft, chatId);
        draftByChat.delete(chatId);
        await tgSend(
          chatId,
          `✅ <b>Guardado</b>\nID: <code>${escapeHtml(expenseId)}</code>`
        );
      } catch (e) {
        logBigQueryError(e);
        const pretty = formatBigQueryError(e);
        await tgSend(chatId, `❌ <b>No se pudo guardar</b>\n${escapeHtml(pretty)}`);
      }
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

      // total compra debe existir; si no, usa amount_mxn (por seguridad)
      if (!existing.msi_total_amount || Number(existing.msi_total_amount) <= 0) {
        existing.msi_total_amount = Number(existing.amount_mxn);
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
    const localParseStart = Date.now();
    let draft = localParseExpense(text);
    const localParseMs = Date.now() - localParseStart;

    console.info(
      `⏱️ local-parse=${localParseMs}ms amounts=${draft.__meta?.amounts_found || 0} msi=${draft.is_msi}`
    );

    const wantsMsi = draft.is_msi || looksLikeMsiText(text);
    const needsAI = shouldCallDeepSeek(draft);
    let deepSeekMs = null;

    if (needsAI) {
      try {
        const aiStart = Date.now();
        deepSeekCalls += 1;
        const base = buildCompletionBase(draft);
        const ai = await callDeepSeekComplete(text, base);
        deepSeekMs = Date.now() - aiStart;
        console.info(`🤖 deepseek=${deepSeekMs}ms calls=${deepSeekCalls}`);

        draft = mergeLocalAndAI(draft, ai);
      } catch (e) {
        console.warn("DeepSeek complete failed, usando parse local:", e?.message || e);
      }
    }

    // =========================
    // FLUJO B: MSI (step 1)
    // - parsea todo lo que se pueda del gasto,
    // - guarda draft incompleto,
    // - pregunta meses.
    // =========================
    if (wantsMsi) {
      draft.raw_text = text;
      draft.purchase_date = overrideRelativeDate(text, draft.purchase_date);

      // interpretamos el monto del texto como TOTAL de la compra
      draft.is_msi = true;
      draft.msi_total_amount = Number(draft.msi_total_amount || draft.amount_mxn);
      draft.msi_start_month = monthStartISO(draft.purchase_date);

      const err = validateDraft(draft);
      if (err) {
        await tgSend(chatId, err);
        return;
      }

      if (!Number.isFinite(draft.msi_months) || draft.msi_months <= 1) {
        draft.msi_months = null;
        draft.__state = "awaiting_msi_months";

        draftByChat.set(chatId, draft);
        await tgSend(
          chatId,
          "🧾 Detecté <b>MSI</b>. ¿A cuántos meses? (responde solo el número, ej: <code>6</code>)"
        );
        return;
      }

      draft.amount_mxn = round2(Number(draft.msi_total_amount) / draft.msi_months);
      delete draft.__state;

      draftByChat.set(chatId, draft);
      await tgSend(chatId, preview(draft), { reply_markup: mainKeyboard() });
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

    draft.raw_text = text;
    draft.purchase_date = overrideRelativeDate(text, draft.purchase_date);

    if (!isFinite(draft.amount_mxn) || draft.amount_mxn <= 0) {
      draft = naiveParse(text);
      draft.raw_text = text;
      draft.purchase_date = overrideRelativeDate(text, draft.purchase_date);
    }

    const err = validateDraft(draft);
    if (err) {
      await tgSend(chatId, err);
      return;
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

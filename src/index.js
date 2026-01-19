// index.js
import express from "express";

import { warnMissingEnv } from "./config.js";
import {
  tgSend,
  mainKeyboard,
  editMenuKeyboard,
  answerCallbackQuery,
  escapeHtml
} from "./telegram.js";
import { insertExpenseAndMaybeInstallments } from "./storage/bigquery.js";
import {
  callDeepSeekParse,
  callDeepSeekComplete,
  validateParsedFromAI,
  validateCompletionFromAI
} from "./deepseek.js";
import { getAllowedPaymentMethods } from "./cards.js";
import { localParse, validateDraft, overrideRelativeDate, preview } from "./parsing.js";
import { runDailyCardReminders } from "./reminders.js";

warnMissingEnv();

const app = express();
app.use(express.json({ limit: "1mb" }));

// Draft store (MVP)
const draftByChat = new Map(); // chatId -> draft
const LOG_PERF = String(process.env.LOG_PERF || "true") !== "false";

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

function logPerf(payload) {
  if (!LOG_PERF) return;
  console.log(JSON.stringify({ type: "perf", ...payload }));
}

function getPerfInit() {
  return { local_parse_ms: 0, llm_ms: 0, llm_calls: 0 };
}

function recordDuration(start, target, key) {
  const elapsed = Date.now() - start;
  target[key] += elapsed;
  return elapsed;
}

function shouldCallCompletion(draft) {
  const text = draft?.__local?.descriptionText || draft?.description || "";
  const words = String(text)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const hasUsefulDescription = words.length >= 2;
  const complex = words.length >= 6;
  return !hasUsefulDescription || complex;
}

/* =======================
 * Routes
 * ======================= */
app.get("/", (req, res) => res.status(200).send("OK"));

app.post("/telegram-webhook", async (req, res) => {
  res.status(200).send("ok");

  const requestStart = Date.now();
  const perf = getPerfInit();

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
    const allowedMethods = await getAllowedPaymentMethods();

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
          allowedMethods.map((x) => `- ${escapeHtml(x)}`).join("\n"),
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
    const wantsMsi = looksLikeMsiText(text);

    // =========================
    // FLUJO B: MSI (step 1)
    // - parsea todo lo que se pueda del gasto,
    // - guarda draft incompleto,
    // - pregunta meses.
    // =========================
    if (wantsMsi) {
      let draft = null;
      // Local-first parsing para evitar latencia de LLM.
      const localStart = Date.now();
      const localDraft = localParse(text, allowedMethods);
      recordDuration(localStart, perf, "local_parse_ms");

      const localErr = validateDraft(localDraft, allowedMethods);
      if (!localErr) {
        draft = localDraft;
      } else {
        // 1) intentar IA
        const llmStart = Date.now();
        perf.llm_calls += 1;
        try {
          const parsed = await callDeepSeekParse(text);
          const v = await validateParsedFromAI(parsed);

          if (v.ok) {
            draft = v.draft;
          } else {
            // si el AI ya detectó MSI sin meses y nos dio draft parcial
            if (v.needs_msi_months && v.draft) {
              draft = v.draft;
            }
          }
        } catch (e) {
          draft = null;
        } finally {
          recordDuration(llmStart, perf, "llm_ms");
        }
      }

      // 2) fallback local si no hay draft usable
      if (!draft) {
        draft = localDraft;
        const err = validateDraft(draft, allowedMethods);
        if (err) {
          await tgSend(chatId, err);
          return;
        }
      }

      // 3) fija MSI incompleto
      draft.raw_text = text;
      draft.purchase_date = overrideRelativeDate(text, draft.purchase_date);

      // interpretamos el monto del texto como TOTAL de la compra
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
    // Local-first parsing para reducir llamadas LLM.
    const localStart = Date.now();
    const localDraft = localParse(text, allowedMethods);
    recordDuration(localStart, perf, "local_parse_ms");

    const localErr = validateDraft(localDraft, allowedMethods);
    if (!localErr) {
      draft = localDraft;
      draft.raw_text = text;
      draft.purchase_date = overrideRelativeDate(text, draft.purchase_date);

      if (shouldCallCompletion(draft)) {
        const llmStart = Date.now();
        perf.llm_calls += 1;
        try {
          const completion = await callDeepSeekComplete(text, {
            amount_mxn: draft.amount_mxn,
            payment_method: draft.payment_method,
            purchase_date: draft.purchase_date
          });
          const completed = validateCompletionFromAI(completion);
          draft.category = completed.category;
          draft.merchant = completed.merchant;
          draft.description = completed.description;
        } catch (e) {
          draft.category = "Other";
          draft.merchant = "";
          if (!draft.description) draft.description = "Gasto";
        } finally {
          recordDuration(llmStart, perf, "llm_ms");
        }
      }
    } else {
      const llmStart = Date.now();
      perf.llm_calls += 1;
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
        console.error("DeepSeek parse failed, fallback local:", e);

        draft = localDraft;
        draft.raw_text = text;
        draft.purchase_date = overrideRelativeDate(text, draft.purchase_date);

        const err = validateDraft(draft, allowedMethods);
        if (err) {
          await tgSend(chatId, err);
          return;
        }
      } finally {
        recordDuration(llmStart, perf, "llm_ms");
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
  } finally {
    const totalMs = Date.now() - requestStart;
    logPerf({
      route: "/telegram-webhook",
      total_ms: totalMs,
      local_parse_ms: perf.local_parse_ms,
      llm_ms: perf.llm_ms,
      llm_calls: perf.llm_calls
    });
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

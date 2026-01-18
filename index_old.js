import express from "express";
import bigqueryPkg from "@google-cloud/bigquery";
const { BigQuery } = bigqueryPkg;
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ===== Env vars =====
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

const BQ_PROJECT_ID = process.env.BQ_PROJECT_ID || "project-c9256c63-847c-4b18-ac8";
const BQ_DATASET = process.env.BQ_DATASET || "gastos";
const BQ_TABLE = process.env.BQ_TABLE || "expenses";

if (!TELEGRAM_BOT_TOKEN) console.warn("Missing env var: TELEGRAM_BOT_TOKEN");
if (!DEEPSEEK_API_KEY) console.warn("Missing env var: DEEPSEEK_API_KEY (DeepSeek parse will fail and fallback to naive)");

// ===== BigQuery client =====
const bq = new BigQuery({ projectId: BQ_PROJECT_ID });

// ===== Allowed values =====
const ALLOWED_PAYMENT_METHODS = [
  "Banorte Platino",
  "American Express",
  "Amex Aeromexico",
  "Banorte Marriott",
  "Banorte United",
  "Klar",
  "HSBC Viva Plus",
  "Santander",
  "Rappi Card",
  "Liverpool",
  "Retiro de Cash",
  "BBVA Platino"
];

const ALLOWED_CATEGORIES = [
  "Car maintenance","Car payment","TAG","Clothing","Condo fees","Debt","E-commerce",
  "Entertainment","Gas","Gifts","Going out","Groceries","Gym","Home maintenance",
  "Insurance","Medical","Mortgage","Other","Public transportation","Rent","Restaurant",
  "Telecom","Travel","Utilities","Work","Beauty & Self Care","Transport",
  "Subscriptions","Savings"
];

// ===== Helpers: HTML escaping (para parse_mode HTML) =====
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// ===== Telegram =====
async function tgSend(chatId, text, extra = {}) {
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

async function answerCallbackQuery(callbackQueryId) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
  // No es crítico validar respuesta aquí; con que no truene basta.
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId })
  });
}

// ===== BigQuery insert =====
async function insertExpenseToBQ(draft, chatId) {
  const table = bq.dataset(BQ_DATASET).table(BQ_TABLE);

  const row = {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    purchase_date: draft.purchase_date,     // "YYYY-MM-DD"
    amount_mxn: Number(draft.amount_mxn),
    payment_method: draft.payment_method,
    category: draft.category || "Other",
    merchant: draft.merchant || null,
    description: draft.description || null,
    raw_text: draft.raw_text || null,
    source: "telegram",
    chat_id: String(chatId)
  };

  await table.insert([row], { skipInvalidRows: false, ignoreUnknownValues: false });
  return row.id;
}

// ===== DeepSeek: prompt + call =====
function deepSeekSystemInstruction() {
  return [
    "Eres un parser de gastos. Devuelve UNICAMENTE JSON válido (sin backticks, sin texto extra).",
    "Si falta un dato crítico o hay ambigüedad, devuelve JSON con {\"error\":\"...\"}.",
    "NO inventes. Si no estás seguro, error.",
    "payment_method debe ser EXACTAMENTE uno de la lista permitida.",
    "category debe ser EXACTAMENTE una de la lista permitida.",
    "purchase_date debe ser YYYY-MM-DD.",
    "Si el usuario escribe 'Amex', es ambiguo: debe ser 'American Express' o 'Amex Aeromexico' → error pidiendo aclaración.",
    "merchant debe ser un nombre corto y limpio (ej. 'Uber', 'Chedraui', 'Amazon').",
    "description debe ser corta y útil.",
    "Reglas de fecha: si el texto contiene 'hoy' usa Hoy; si contiene 'ayer' usa Hoy - 1 día; si contiene 'antier' o 'anteayer' usa Hoy - 2 días. Esto es obligatorio."
  ].join(" ");
}

function deepSeekUserPrompt(text, todayISO) {
  return [
    "Extrae un gasto del texto del usuario.",
    "",
    `Hoy es: ${todayISO} (YYYY-MM-DD).`,
    "",
    "Texto del usuario:",
    text,
    "",
    "Devuelve SOLO JSON con una de estas dos formas:",
    "1) Éxito:",
    JSON.stringify({
      amount_mxn: 230,
      payment_method: "Banorte Platino",
      category: "Transport",
      purchase_date: "2026-01-16",
      merchant: "Uber",
      description: "Viaje Uber"
    }),
    "2) Error (si falta info o hay duda):",
    JSON.stringify({ error: "Explica qué falta o qué es ambiguo y qué debe aclarar el usuario." }),
    "",
    "Métodos de pago permitidos:",
    ALLOWED_PAYMENT_METHODS.join(" | "),
    "",
    "Categorías permitidas:",
    ALLOWED_CATEGORIES.join(" | ")
  ].join("\n");
}

function extractJsonObject(text) {
  const m = (text || "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("No JSON object found in model output");
  return JSON.parse(m[0]);
}

async function callDeepSeekParse(text) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("Missing env var: DEEPSEEK_API_KEY");

  const today = new Date().toISOString().slice(0, 10);
  const payload = {
    model: "deepseek-chat",
    temperature: 0.2,
    messages: [
      { role: "system", content: deepSeekSystemInstruction() },
      { role: "user", content: deepSeekUserPrompt(text, today) }
    ]
  };

  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  const bodyText = await res.text();
  if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}: ${bodyText}`);

  const data = JSON.parse(bodyText);
  const out = data?.choices?.[0]?.message?.content || "";
  return extractJsonObject(out);
}

function validateParsedFromAI(obj) {
  if (obj?.error) return { ok: false, error: String(obj.error) };

  const d = {
    amount_mxn: Number(obj.amount_mxn),
    payment_method: String(obj.payment_method || ""),
    category: String(obj.category || ""),
    purchase_date: String(obj.purchase_date || ""),
    merchant: String(obj.merchant || ""),
    description: String(obj.description || "")
  };

  if (!isFinite(d.amount_mxn) || d.amount_mxn <= 0) {
    return { ok: false, error: "Monto inválido. Ej: 230 Uber Banorte Platino ayer" };
  }

  if (d.payment_method.toLowerCase() === "amex") {
    return { ok: false, error: "❌ 'Amex' es ambiguo. Usa: American Express o Amex Aeromexico." };
  }

  if (!ALLOWED_PAYMENT_METHODS.includes(d.payment_method)) {
    return { ok: false, error: "Método de pago inválido. Usa uno de:\n- " + ALLOWED_PAYMENT_METHODS.join("\n- ") };
  }

  if (!ALLOWED_CATEGORIES.includes(d.category)) {
    return { ok: false, error: "Categoría inválida. Debe ser una de tu lista (ej. Transport, Groceries, Restaurant)." };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.purchase_date)) {
    return { ok: false, error: "Fecha inválida. Debe ser YYYY-MM-DD (ej. 2026-01-16)." };
  }

  if (!d.description) d.description = "Gasto";

  return { ok: true, draft: d };
}

// ===== Relative date override (determinístico) =====
function minusDaysISO(todayISO, days) {
  const d = new Date(todayISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function overrideRelativeDate(text, currentISO) {
  const t = (text || "").toLowerCase();

  const explicit = (text.match(/\b\d{4}-\d{2}-\d{2}\b/) || [])[0];
  if (explicit) return explicit;

  const todayISO = new Date().toISOString().slice(0, 10);

  if (/\bantier\b|\banteayer\b/.test(t)) return minusDaysISO(todayISO, 2);
  if (/\bayer\b/.test(t)) return minusDaysISO(todayISO, 1);
  if (/\bhoy\b/.test(t)) return todayISO;

  return currentISO;
}

// ===== Naive parsing fallback =====
function naiveParse(text) {
  const m = text.match(/(\d+(\.\d+)?)/);
  const amount = m ? Number(m[1]) : NaN;

  const pm = ALLOWED_PAYMENT_METHODS.find(x => text.toLowerCase().includes(x.toLowerCase())) || "";
  const category = "Other";

  const d = (text.match(/\b\d{4}-\d{2}-\d{2}\b/) || [])[0];
  const today = new Date().toISOString().slice(0, 10);

  const desc = text.replace(m ? m[0] : "", "").trim();

  return {
    amount_mxn: amount,
    payment_method: pm,
    category,
    purchase_date: d || today,
    merchant: "",
    description: desc || "Gasto"
  };
}

function validateDraft(d) {
  if (!isFinite(d.amount_mxn) || d.amount_mxn <= 0) {
    return "❌ Monto inválido. Ej: 230 Uber American Express ayer";
  }

  if (!d.payment_method) {
    if ((d.description || "").toLowerCase().includes("amex")) {
      return "❌ 'Amex' es ambiguo. Usa: American Express o Amex Aeromexico.";
    }
    return "❌ Método de pago inválido. Usa uno de:\n- " + ALLOWED_PAYMENT_METHODS.join("\n- ");
  }

  if (!ALLOWED_CATEGORIES.includes(d.category)) d.category = "Other";

  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.purchase_date)) {
    return "❌ Fecha inválida. Usa YYYY-MM-DD (luego aceptaremos 'hoy/ayer' con IA).";
  }

  return null;
}

// ===== Preview + botones =====
function preview(d) {
  const lines = [
    "🧾 <b>Confirmar gasto</b>",
    `Monto: <b>$${Math.round(d.amount_mxn)} MXN</b>`,
    `Método: <b>${escapeHtml(d.payment_method)}</b>`,
    `Fecha: <b>${escapeHtml(d.purchase_date)}</b>`,
    `Categoría: <b>${escapeHtml(d.category)}</b>`,
    `Descripción: ${escapeHtml(d.description)}`
  ];
  if (d.merchant) lines.push(`Comercio: ${escapeHtml(d.merchant)}`);
  lines.push("", "Toca un botón:");
  return lines.join("\n");
}

function confirmKeyboard() {
  return {
    inline_keyboard: [[
      { text: "✅ Confirmar", callback_data: "confirm" },
      { text: "❌ Cancelar", callback_data: "cancel" }
    ]]
  };
}

// ===== Draft store (MVP) =====
const draftByChat = new Map(); // chatId -> draft

// ===== Health =====
app.get("/", (req, res) => res.status(200).send("OK"));

// ===== Webhook =====
app.post("/telegram-webhook", async (req, res) => {
  res.status(200).send("ok");

  try {
    const update = req.body;

    // ---- 1) BOTONES (callback_query) ----
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

      await answerCallbackQuery(cb.id); // quita el “loading…”
      return;
    }

    // ---- 2) MENSAJES NORMAL (message) ----
    const msg = update.message || update.edited_message;
    if (!msg?.chat?.id) return;

    const chatId = String(msg.chat.id);
    const text = (msg.text || "").trim();

    if (!text) {
      await tgSend(chatId, '✅ conectado. Mándame un gasto como: <b>230</b> Uber American Express ayer\n(Escribe <b>ayuda</b> para ejemplos)');
      return;
    }

    const low = text.toLowerCase();

    // Help
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

    // Cancel (texto)
    if (low === "cancelar" || low === "/cancel") {
      draftByChat.delete(chatId);
      await tgSend(chatId, "🧹 <b>Cancelado</b>.");
      return;
    }

    // Confirm (texto)
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

    // Ping si no hay números
    if (!/\d/.test(text)) {
      await tgSend(chatId, '✅ conectado. Mándame un gasto como: <b>230</b> Uber American Express ayer\n(Escribe <b>ayuda</b> para ejemplos)');
      return;
    }

    // ===== Parse: DeepSeek with fallback to naive =====
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

    // Guarda borrador y manda preview con botones
    draftByChat.set(chatId, draft);
    await tgSend(chatId, preview(draft), { reply_markup: confirmKeyboard() });

  } catch (e) {
    console.error(e);
  }
});

// ===== Start =====
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`listening on ${PORT}`));

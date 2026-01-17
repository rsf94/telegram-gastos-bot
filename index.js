import express from "express";
import { BigQuery } from "@google-cloud/bigquery";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ===== Env vars =====
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY; // (lo usaremos después)

const BQ_PROJECT_ID = process.env.BQ_PROJECT_ID || "project-c9256c63-847c-4b18-ac8";
const BQ_DATASET = process.env.BQ_DATASET || "gastos";
const BQ_TABLE = process.env.BQ_TABLE || "expenses";

if (!TELEGRAM_BOT_TOKEN) {
  console.warn("Missing env var: TELEGRAM_BOT_TOKEN");
}

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

// ===== Telegram =====
async function tgSend(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram sendMessage failed ${res.status}: ${body}`);
  }
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

// ===== Draft store (MVP) =====
const draftByChat = new Map(); // chatId -> draft

// ===== Health =====
app.get("/", (req, res) => res.status(200).send("OK"));

// ===== Webhook =====
app.post("/telegram-webhook", async (req, res) => {
  // Responde 200 rápido para que Telegram no reintente
  res.status(200).send("ok");

  try {
    const update = req.body;
    const msg = update.message || update.edited_message;
    if (!msg?.chat?.id) return;

    const chatId = String(msg.chat.id);
    const text = (msg.text || "").trim();

    if (!text) {
      await tgSend(chatId, '✅ conectado. Mándame un gasto como: 230 Uber American Express ayer\n(Escribe "ayuda" para ejemplos)');
      return;
    }

    const low = text.toLowerCase();

    // Help
    if (low === "ayuda" || low === "/help") {
      await tgSend(chatId, [
        "🧾 Envíame un gasto en texto. Ej:",
        "230 Uber American Express ayer",
        "",
        "Luego responde:",
        "- confirmar",
        "- cancelar",
        "",
        "Métodos válidos:",
        ALLOWED_PAYMENT_METHODS.map(x => `- ${x}`).join("\n"),
        "",
        "Nota: 'Amex' a secas es ambiguo."
      ].join("\n"));
      return;
    }

    // Cancel
    if (low === "cancelar" || low === "/cancel") {
      draftByChat.delete(chatId);
      await tgSend(chatId, "🧹 Cancelado.");
      return;
    }

    // Confirm -> insert BigQuery
    if (low === "confirmar" || low === "/confirm") {
      const draft = draftByChat.get(chatId);
      if (!draft) {
        await tgSend(chatId, "No tengo borrador. Mándame un gasto primero.");
        return;
      }

      const expenseId = await insertExpenseToBQ(draft, chatId);
      draftByChat.delete(chatId);
      await tgSend(chatId, `✅ Guardado en BigQuery. ID: ${expenseId}`);
      return;
    }

    // If no number, treat as ping (avoid "monto inválido" for HI/hola)
    if (!/\d/.test(text)) {
      await tgSend(chatId, '✅ conectado. Mándame un gasto como: 230 Uber American Express ayer\n(Escribe "ayuda" para ejemplos)');
      return;
    }

    // Parse (naive for now; later DeepSeek)
    const draft = naiveParse(text);
    draft.raw_text = text; // keep original for audit/debug

    const err = validateDraft(draft);
    if (err) {
      await tgSend(chatId, err);
      return;
    }

    draftByChat.set(chatId, draft);
    await tgSend(chatId, preview(draft));

  } catch (e) {
    console.error(e);
    // No siempre conviene mandar error al usuario; pero si quieres:
    // await tgSend(chatId, "❌ Error interno, revisa logs.");
  }
});

// ===== Parsing =====
function naiveParse(text) {
  // primer número = monto
  const m = text.match(/(\d+(\.\d+)?)/);
  const amount = m ? Number(m[1]) : NaN;

  // método de pago: busca alguno permitido dentro del texto (case-insensitive)
  const pm = ALLOWED_PAYMENT_METHODS.find(x => text.toLowerCase().includes(x.toLowerCase())) || "";

  // categoría: por ahora Other (luego DeepSeek)
  const category = "Other";

  // fecha: si incluye YYYY-MM-DD úsala; si no, hoy
  const d = (text.match(/\b\d{4}-\d{2}-\d{2}\b/) || [])[0];
  const today = new Date().toISOString().slice(0, 10);

  // description: todo el texto sin el monto
  const desc = text.replace(m ? m[0] : "", "").trim();

  return {
    amount_mxn: amount,
    payment_method: pm,
    category,
    purchase_date: d || today,
    merchant: "", // luego lo llenamos con IA
    description: desc || "Gasto"
  };
}

function validateDraft(d) {
  if (!isFinite(d.amount_mxn) || d.amount_mxn <= 0) {
    return "❌ Monto inválido. Ej: 230 Uber American Express ayer";
  }

  if (!d.payment_method) {
    // amex ambiguo
    if ((d.description || "").toLowerCase().includes("amex")) {
      return "❌ 'Amex' es ambiguo. Usa: American Express o Amex Aeromexico.";
    }
    return "❌ Método de pago inválido. Usa uno de:\n- " + ALLOWED_PAYMENT_METHODS.join("\n- ");
  }

  // category safety
  if (!ALLOWED_CATEGORIES.includes(d.category)) d.category = "Other";

  // date format check
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.purchase_date)) {
    return "❌ Fecha inválida. Usa YYYY-MM-DD (luego aceptaremos 'hoy/ayer' con IA).";
  }

  return null;
}

function preview(d) {
  return [
    "🧾 Confirmar gasto",
    `Monto: $${Math.round(d.amount_mxn)} MXN`,
    `Método: ${d.payment_method}`,
    `Fecha: ${d.purchase_date}`,
    `Categoría: ${d.category}`,
    `Descripción: ${d.description}`,
    "",
    "Responde: confirmar / cancelar"
  ].join("\n");
}

// ===== Start =====
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`listening on ${PORT}`));

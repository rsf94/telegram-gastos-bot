import express from "express";
import { google } from "googleapis";

const app = express();
app.use(express.json({ limit: "1mb" }));

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY; // (lo usaremos después)
const SHEET_ID = process.env.SHEET_ID;
const SHEET_TAB = process.env.SHEET_TAB || "Gastos";
const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

const ALLOWED_PAYMENT_METHODS = [
  "Banorte Platino","American Express","Amex Aeromexico","Banorte Marriott","Banorte United",
  "Klar","HSBC Viva Plus","Santander","Rappi Card","Liverpool","Retiro de Cash","BBVA Platino"
];

const ALLOWED_CATEGORIES = [
  "Car maintenance","Car payment","TAG","Clothing","Condo fees","Debt","E-commerce",
  "Entertainment","Gas","Gifts","Going out","Groceries","Gym","Home maintenance",
  "Insurance","Medical","Mortgage","Other","Public transportation","Rent","Restaurant",
  "Telecom","Travel","Utilities","Work","Beauty & Self Care","Transport",
  "Subscriptions","Savings"
];

// --- Google Sheets client ---
function getSheetsClient() {
  const creds = JSON.parse(SA_JSON);
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
  return google.sheets({ version: "v4", auth });
}

// --- Telegram sendMessage ---
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

// --- Draft in-memory (para MVP). Luego lo pasamos a Firestore/Redis si quieres ---
const draftByChat = new Map(); // chatId -> draft

app.get("/", (req, res) => res.status(200).send("OK"));

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
      await tgSend(chatId, "Mándame un gasto en texto. Ej: 230 Uber American Express ayer");
      return;
    }

    const low = text.toLowerCase();
    if (low === "ayuda" || low === "/help") {
      await tgSend(chatId, [
        "🧾 Envíame un gasto en texto. Ej:",
        "230 Uber American Express ayer",
        "",
        "Luego responde:",
        "- confirmar",
        "- cancelar",
        "",
        "Nota: 'Amex' a secas es ambiguo."
      ].join("\n"));
      return;
    }

    if (low === "cancelar" || low === "/cancel") {
      draftByChat.delete(chatId);
      await tgSend(chatId, "🧹 Cancelado.");
      return;
    }

    if (low === "confirmar" || low === "/confirm") {
      const draft = draftByChat.get(chatId);
      if (!draft) {
        await tgSend(chatId, "No tengo borrador. Mándame un gasto primero.");
        return;
      }

      // Append row en Sheets
      const sheets = getSheetsClient();
      const row = [
        new Date().toISOString(),   // Marca temporal
        "",                         // email (vacío)
        draft.amount_mxn,           // Monto
        "",                         // Tpo
        draft.category,             // Categoría
        draft.payment_method,       // Método
        draft.description,          // Descripción
        "",                         // Ticket
        draft.purchase_date,        // Fecha compra
        draft.merchant,             // Comercio
        "", "",                     // Columna 10 / Meses
        draft.purchase_date         // Fecha efectiva
      ];

      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_TAB}!A1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [row] }
      });

      draftByChat.delete(chatId);
      await tgSend(chatId, "✅ Guardado en tu Sheet.");
      return;
    }

    // MVP parse súper simple (sin DeepSeek aún): intenta formato:
    // "<monto> <merchant> <metodo> [fecha opcional]"
    // Para producción lo pasamos a DeepSeek JSON estricto.
    const draft = naiveParse(text);

    const err = validateDraft(draft);
    if (err) {
      await tgSend(chatId, err);
      return;
    }

    draftByChat.set(chatId, draft);
    await tgSend(chatId, preview(draft));

  } catch (e) {
    // Si quieres, aquí puedes enviarte a ti mismo el error
    console.error(e);
  }
});

function naiveParse(text) {
  // MUY básico: primer número = monto, resto lo dejamos como descripción
  const m = text.match(/(\d+(\.\d+)?)/);
  const amount = m ? Number(m[1]) : NaN;

  // método de pago: busca alguno permitido dentro del texto
  const pm = ALLOWED_PAYMENT_METHODS.find(x => text.toLowerCase().includes(x.toLowerCase())) || "";

  // categoría: por ahora Other (luego DeepSeek)
  const category = "Other";

  // fecha: si incluye YYYY-MM-DD úsala; si no, hoy
  const d = (text.match(/\b\d{4}-\d{2}-\d{2}\b/) || [])[0];
  const today = new Date().toISOString().slice(0,10);

  // merchant/description: por ahora todo el texto sin monto
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
  if (!isFinite(d.amount_mxn) || d.amount_mxn <= 0) return "❌ Monto inválido. Ej: 230 Uber American Express ayer";

  if (!d.payment_method) {
    // caso especial amex ambiguo
    if (d.description.toLowerCase().includes("amex")) {
      return "❌ 'Amex' es ambiguo. Usa: American Express o Amex Aeromexico.";
    }
    return "❌ Método de pago inválido. Usa uno de:\n- " + ALLOWED_PAYMENT_METHODS.join("\n- ");
  }

  if (!ALLOWED_CATEGORIES.includes(d.category)) d.category = "Other";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.purchase_date)) return "❌ Fecha inválida. Usa YYYY-MM-DD o di 'hoy/ayer' (lo meteremos con IA).";

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

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`listening on ${PORT}`));

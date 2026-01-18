// src/deepseek.js
import { DEEPSEEK_API_KEY, ALLOWED_CATEGORIES } from "./config.js";
import { getAllowedPaymentMethods } from "./cards.js";
import { todayISOInTZ } from "./parsing.js";

function deepSeekSystemInstruction() {
  return [
    "Eres un parser de gastos. Devuelve UNICAMENTE JSON válido (sin backticks, sin texto extra).",
    "Si falta un dato crítico o hay ambigüedad, devuelve JSON con {\"error\":\"...\"}.",
    "NO inventes. Si no estás seguro, error.",
    "",
    "Campos obligatorios en éxito: amount_mxn, payment_method, category, purchase_date, merchant, description.",
    "payment_method debe ser EXACTAMENTE uno de la lista permitida.",
    "category debe ser EXACTAMENTE una de la lista permitida.",
    "purchase_date debe ser YYYY-MM-DD.",
    "Si el usuario escribe 'Amex', es ambiguo: debe ser 'American Express' o 'Amex Aeromexico' → error pidiendo aclaración.",
    "merchant debe ser un nombre corto y limpio (ej. 'Uber', 'Chedraui', 'Amazon').",
    "description debe ser corta y útil.",
    "",
    "=== MSI ===",
    "Detecta MSI si el texto contiene 'msi' o 'meses' o 'a N meses' o 'N meses sin intereses'.",
    "Si detectas MSI, incluye además:",
    "- is_msi: true",
    "- msi_months: N (entero > 1)",
    "- msi_total_amount: total de la compra (NUMERIC). Si no se menciona otro total, usa amount_mxn como total.",
    "Si hay MSI pero no puedes inferir N con certeza, devuelve error solicitando los meses.",
    "Si no hay MSI, incluye is_msi:false y deja msi_* como null/omitidos.",
    "",
    "=== Reglas de fecha ===",
    "Reglas de fecha: si el texto contiene 'hoy' usa Hoy; si contiene 'ayer' usa Hoy - 1 día; si contiene 'antier' o 'anteayer' usa Hoy - 2 días. Esto es obligatorio."
  ].join(" ");
}

function deepSeekUserPrompt(text, todayISO, allowedPaymentMethods) {
  return [
    "Extrae un gasto del texto del usuario.",
    "",
    `Hoy es: ${todayISO} (YYYY-MM-DD).`,
    "",
    "Texto del usuario:",
    text,
    "",
    "Devuelve SOLO JSON con una de estas dos formas:",
    "",
    "1) Éxito SIN MSI:",
    JSON.stringify({
      amount_mxn: 230,
      payment_method: "Banorte Platino",
      category: "Transport",
      purchase_date: "2026-01-16",
      merchant: "Uber",
      description: "Viaje Uber",
      is_msi: false,
      msi_months: null,
      msi_total_amount: null
    }),
    "",
    "2) Éxito CON MSI (ej: '13878 Palacio de Hierro American Express a 6 meses'):",
    JSON.stringify({
      amount_mxn: 13878,
      payment_method: "American Express",
      category: "E-commerce",
      purchase_date: "2026-01-18",
      merchant: "Palacio de Hierro",
      description: "Compra a MSI",
      is_msi: true,
      msi_months: 6,
      msi_total_amount: 13878
    }),
    "",
    "3) Error (si falta info o hay duda):",
    JSON.stringify({
      error: "Explica qué falta o qué es ambiguo y qué debe aclarar el usuario."
    }),
    "",
    "Métodos de pago permitidos (payment_method):",
    allowedPaymentMethods.join(" | "),
    "",
    "Categorías permitidas (category):",
    ALLOWED_CATEGORIES.join(" | ")
  ].join("\n");
}

function extractJsonObject(text) {
  const m = (text || "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("No JSON object found in model output");
  return JSON.parse(m[0]);
}

function parseMaybeInt(x) {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function parseMaybeNumber(x) {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return n;
}

export async function callDeepSeekParse(text) {
  if (!DEEPSEEK_API_KEY) throw new Error("Missing env var: DEEPSEEK_API_KEY");

  const today = todayISOInTZ(); // CDMX
  const allowedPaymentMethods = await getAllowedPaymentMethods(); // dinámico (card_rules)

  const payload = {
    model: "deepseek-chat",
    temperature: 0.2,
    messages: [
      { role: "system", content: deepSeekSystemInstruction() },
      { role: "user", content: deepSeekUserPrompt(text, today, allowedPaymentMethods) }
    ]
  };

  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify(payload)
  });

  const bodyText = await res.text();
  if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}: ${bodyText}`);

  const data = JSON.parse(bodyText);
  const out = data?.choices?.[0]?.message?.content || "";
  return extractJsonObject(out);
}

// ✅ async porque payment methods son dinámicos
export async function validateParsedFromAI(obj) {
  if (obj?.error) return { ok: false, error: String(obj.error) };

  const isMsi = obj.is_msi === true;

  const d = {
    amount_mxn: Number(obj.amount_mxn),
    payment_method: String(obj.payment_method || ""),
    category: String(obj.category || ""),
    purchase_date: String(obj.purchase_date || ""),
    merchant: String(obj.merchant || ""),
    description: String(obj.description || ""),
    is_msi: isMsi,
    msi_months: isMsi ? parseMaybeInt(obj.msi_months) : null,
    msi_total_amount: isMsi ? parseMaybeNumber(obj.msi_total_amount ?? obj.amount_mxn) : null
  };

  if (!isFinite(d.amount_mxn) || d.amount_mxn <= 0) {
    return { ok: false, error: "Monto inválido. Ej: 230 Uber Banorte Platino ayer" };
  }

  if (d.payment_method.toLowerCase() === "amex") {
    return { ok: false, error: "❌ 'Amex' es ambiguo. Usa: American Express o Amex Aeromexico." };
  }

  const allowedPaymentMethods = await getAllowedPaymentMethods();
  if (!allowedPaymentMethods.includes(d.payment_method)) {
    return {
      ok: false,
      error: "Método de pago inválido. Usa uno de:\n- " + allowedPaymentMethods.join("\n- ")
    };
  }

  if (!ALLOWED_CATEGORIES.includes(d.category)) {
    return {
      ok: false,
      error: "Categoría inválida. Debe ser una de tu lista (ej. Transport, Groceries, Restaurant)."
    };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.purchase_date)) {
    return { ok: false, error: "Fecha inválida. Debe ser YYYY-MM-DD (ej. 2026-01-16)." };
  }

  if (!d.description) d.description = "Gasto";

  // ✅ Validación MSI
  if (d.is_msi) {
    if (!d.msi_months || !Number.isFinite(d.msi_months) || d.msi_months < 2) {
      return { ok: false, error: "MSI detectado, pero faltan los meses. Ej: '13878 Palacio American Express a 6 meses'." };
    }
    if (d.msi_months > 60) {
      return { ok: false, error: "MSI inválido: meses demasiado altos. Revisa el número de meses." };
    }
    if (!Number.isFinite(d.msi_total_amount) || d.msi_total_amount <= 0) {
      return { ok: false, error: "MSI inválido: msi_total_amount debe ser > 0." };
    }

    // Si el modelo puso amount_mxn distinto al total, forzamos consistencia:
    // En tu diseño: amount_mxn representa el TOTAL de la compra (para MSI).
    // (El flujo de cash lo calcula installments.)
    d.amount_mxn = Number(d.msi_total_amount);
  }

  return { ok: true, draft: d };
}

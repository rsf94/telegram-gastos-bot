import { DEEPSEEK_API_KEY, ALLOWED_CATEGORIES } from "./config.js";
import { getAllowedPaymentMethods } from "./cards.js";
import { todayISOInTZ } from "./parsing.js";

/* =======================
 * Helpers
 * ======================= */
function extractJsonObject(text) {
  const m = (text || "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("No JSON object found in model output");
  return JSON.parse(m[0]);
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function monthStartISO(yyyyMmDd) {
  return `${String(yyyyMmDd).slice(0, 7)}-01`;
}

/* =======================
 * DeepSeek prompts
 * ======================= */
function deepSeekSystemInstruction() {
  return [
    "Eres un parser de gastos. Devuelve UNICAMENTE JSON válido (sin backticks, sin texto extra).",
    "Si falta un dato crítico o hay ambigüedad, devuelve JSON con {\"error\":\"...\"}.",
    "NO inventes. Si no estás seguro, error.",
    "",
    "Campos obligatorios en éxito:",
    "amount_mxn, payment_method, category, purchase_date, merchant, description.",
    "",
    "payment_method debe ser EXACTAMENTE uno de la lista permitida.",
    "category debe ser EXACTAMENTE una de la lista permitida.",
    "purchase_date debe ser YYYY-MM-DD.",
    "",
    "Si el usuario escribe 'Amex', es ambiguo: debe ser 'American Express' o 'Amex Aeromexico' → error.",
    "",
    "merchant debe ser un nombre corto y limpio (ej. 'Uber', 'Chedraui', 'Amazon').",
    "description debe ser corta y útil.",
    "",
    "=== MSI (Meses Sin Intereses) ===",
    "Si el texto contiene 'msi' o 'meses sin intereses' (ej: '6MSI', '6 MSI', 'a 6 msi'):",
    "- is_msi = true",
    "- msi_months = número de meses (ej: 6)",
    "- msi_total_amount = monto TOTAL de la compra",
    "- amount_mxn = monto mensual = msi_total_amount / msi_months (redondea a 2 decimales)",
    "Si detectas MSI pero no viene el número de meses, devuelve error preguntando: ¿a cuántos meses?",
    "",
    "Reglas de fecha:",
    "- 'hoy' → hoy",
    "- 'ayer' → hoy - 1",
    "- 'antier' / 'anteayer' → hoy - 2",
    "Esto es obligatorio."
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
    "1) Éxito (NO MSI):",
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
    "Ejemplo MSI (flujo mensual):",
    JSON.stringify({
      amount_mxn: 533.17,
      payment_method: "BBVA Platino",
      category: "E-commerce",
      purchase_date: "2026-01-16",
      merchant: "Amazon",
      description: "Compra Amazon",
      is_msi: true,
      msi_months: 6,
      msi_total_amount: 3199
    }),
    "",
    "2) Error:",
    JSON.stringify({
      error: "Explica qué falta o qué es ambiguo y qué debe aclarar el usuario."
    }),
    "",
    "Métodos de pago permitidos:",
    allowedPaymentMethods.join(" | "),
    "",
    "Categorías permitidas:",
    ALLOWED_CATEGORIES.join(" | ")
  ].join("\n");
}

/* =======================
 * Llamada a DeepSeek
 * ======================= */
export async function callDeepSeekParse(text) {
  if (!DEEPSEEK_API_KEY) {
    throw new Error("Missing env var: DEEPSEEK_API_KEY");
  }

  const today = todayISOInTZ();
  const allowedPaymentMethods = await getAllowedPaymentMethods();

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
  if (!res.ok) {
    throw new Error(`DeepSeek HTTP ${res.status}: ${bodyText}`);
  }

  const data = JSON.parse(bodyText);
  const out = data?.choices?.[0]?.message?.content || "";
  return extractJsonObject(out);
}

/* =======================
 * Validación final
 * ======================= */
export async function validateParsedFromAI(obj) {
  if (obj?.error) return { ok: false, error: String(obj.error) };

  const allowedPaymentMethods = await getAllowedPaymentMethods();
  const isMsi = obj.is_msi === true;
  const originalAmount = Number(obj.amount_mxn);

  const d = {
    amount_mxn: Number(obj.amount_mxn),
    payment_method: String(obj.payment_method || ""),
    category: String(obj.category || ""),
    purchase_date: String(obj.purchase_date || ""),
    merchant: String(obj.merchant || ""),
    description: String(obj.description || ""),

    is_msi: isMsi,
    msi_months: isMsi ? Number(obj.msi_months) : null,
    msi_total_amount: isMsi ? Number(obj.msi_total_amount) : null,
    msi_start_month: isMsi ? String(obj.msi_start_month || "") : null
  };

if (d.is_msi) {
  // total amount siempre debe existir
  if (!isFinite(d.msi_total_amount) || d.msi_total_amount <= 0) {
    d.msi_total_amount = originalAmount; // el monto que escribió el user
  }

  // si no viene meses, NO error genérico: devuelve un "needs_months"
  if (!isFinite(d.msi_months) || d.msi_months <= 1) {
    // default msi_start_month al mes de la compra
    d.msi_start_month = monthStartISO(d.purchase_date);
    return { ok: false, needs_msi_months: true, draft: d };
  }

  // si sí vienen meses, ya puedes normalizar
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.msi_start_month)) {
    d.msi_start_month = monthStartISO(d.purchase_date);
  }

  // OJO: aquí aún NO dividas si quieres que el cashflow lo genere installments
  // pero si vas a mantener amount_mxn como “mensual”, entonces sí:
  d.amount_mxn = round2(d.msi_total_amount / d.msi_months);

  return { ok: true, draft: d };
}

  if (d.payment_method.toLowerCase() === "amex") {
    return {
      ok: false,
      error: "❌ 'Amex' es ambiguo. Usa: American Express o Amex Aeromexico."
    };
  }

  if (!allowedPaymentMethods.includes(d.payment_method)) {
    return {
      ok: false,
      error:
        "Método de pago inválido. Usa uno de:\n- " +
        allowedPaymentMethods.join("\n- ")
    };
  }

  if (!ALLOWED_CATEGORIES.includes(d.category)) {
    return {
      ok: false,
      error:
        "Categoría inválida. Debe ser una de tu lista (ej. Transport, Groceries, Restaurant)."
    };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.purchase_date)) {
    return {
      ok: false,
      error: "Fecha inválida. Debe ser YYYY-MM-DD (ej. 2026-01-16)."
    };
  }

  if (!d.description) d.description = "Gasto";

  /* ===== MSI normalization ===== */
  if (d.is_msi) {
    if (!isFinite(d.msi_months) || d.msi_months <= 1) {
      return {
        ok: false,
        error: "MSI detectado pero faltan meses. Ej: '100 gasolina 6MSI BBVA Platino'."
      };
    }

    if (!isFinite(d.msi_total_amount) || d.msi_total_amount <= 0) {
      d.msi_total_amount = originalAmount;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.msi_start_month)) {
      d.msi_start_month = monthStartISO(d.purchase_date);
    }

    d.amount_mxn = round2(d.msi_total_amount / d.msi_months);
  } else {
    d.msi_months = null;
    d.msi_total_amount = null;
    d.msi_start_month = null;
  }

  return { ok: true, draft: d };
}

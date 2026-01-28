import { DEEPSEEK_API_KEY, ALLOWED_CATEGORIES } from "./config.js";
import { getAllowedPaymentMethods } from "./cards.js";
import { todayISOInTZ } from "./parsing.js";

const CATEGORY_CONFIDENCE_THRESHOLD = 0.6;

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
    "- msi_total_amount = monto TOTAL de la compra (el monto del texto)",
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

function deepSeekCompletionSystemInstruction() {
  return [
    "Eres un asistente para completar datos de gastos.",
    "Devuelve UNICAMENTE JSON válido (sin backticks, sin texto extra).",
    "Completa SOLO los campos faltantes (null/vacíos).",
    "NO cambies valores ya provistos.",
    "Si falta un dato crítico o hay ambigüedad, devuelve JSON con {\"error\":\"...\"}.",
    "",
    "payment_method debe ser EXACTAMENTE uno de la lista permitida.",
    "category debe ser EXACTAMENTE una de la lista permitida.",
    "purchase_date debe ser YYYY-MM-DD.",
    "",
    "Si el usuario escribe 'Amex', es ambiguo: debe ser 'American Express' o 'Amex Aeromexico' → error.",
    "",
    "merchant debe ser un nombre corto y limpio.",
    "description debe ser corta y útil."
  ].join(" ");
}

function deepSeekCompletionUserPrompt(text, todayISO, allowedPaymentMethods, base) {
  return [
    "Completa el gasto con base en el texto del usuario.",
    "",
    `Hoy es: ${todayISO} (YYYY-MM-DD).`,
    "",
    "Texto del usuario:",
    text,
    "",
    "Campos actuales (NO cambies los no-null):",
    JSON.stringify(base),
    "",
    "Devuelve SOLO JSON con exactamente las mismas llaves:",
    JSON.stringify({
      amount_mxn: 230,
      payment_method: "Banorte Platino",
      category: "Transport",
      purchase_date: "2026-01-16",
      merchant: "Uber",
      description: "Viaje Uber"
    }),
    "",
    "Métodos de pago permitidos:",
    allowedPaymentMethods.join(" | "),
    "",
    "Categorías permitidas:",
    ALLOWED_CATEGORIES.join(" | ")
  ].join("\n");
}

function deepSeekEnrichSystemInstruction() {
  return [
    "Eres un asistente para enriquecer gastos con category, merchant y description.",
    "Devuelve UNICAMENTE JSON válido (sin backticks, sin texto extra).",
    "NO modifiques amount_mxn, payment_method ni purchase_date (son fijos).",
    "Si falta contexto o hay ambigüedad, devuelve JSON con {\"error\":\"...\"}.",
    "",
    "category debe ser EXACTAMENTE una de la lista permitida.",
    "merchant debe ser un nombre corto y limpio (ej. 'Uber', 'Liverpool', 'Amazon').",
    "description debe ser corta y útil (ej. 'Camisa', 'Gasolina', 'Sushi')."
  ].join(" ");
}

function deepSeekEnrichUserPrompt(text, fixedFields, allowedCategories) {
  return [
    "Enriquece el gasto usando el texto del usuario.",
    "",
    "Texto del usuario:",
    text,
    "",
    "Campos fijos (NO cambies estos valores):",
    JSON.stringify(fixedFields),
    "",
    "Devuelve SOLO JSON con una de estas dos formas:",
    "",
    JSON.stringify({
      category: "Clothing",
      merchant: "Liverpool",
      description: "Camisa"
    }),
    "",
    JSON.stringify({
      error: "Explica qué falta o por qué es ambiguo."
    }),
    "",
    "Categorías permitidas:",
    allowedCategories.join(" | ")
  ].join("\n");
}

/* =======================
 * Llamada a DeepSeek
 * ======================= */
export async function callDeepSeekParse(text) {
  if (!DEEPSEEK_API_KEY) throw new Error("Missing env var: DEEPSEEK_API_KEY");

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
  if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}: ${bodyText}`);

  const data = JSON.parse(bodyText);
  const out = data?.choices?.[0]?.message?.content || "";
  return extractJsonObject(out);
}

export async function callDeepSeekComplete(text, base) {
  if (!DEEPSEEK_API_KEY) throw new Error("Missing env var: DEEPSEEK_API_KEY");

  const today = todayISOInTZ();
  const allowedPaymentMethods = await getAllowedPaymentMethods();

  const payload = {
    model: "deepseek-chat",
    temperature: 0.2,
    messages: [
      { role: "system", content: deepSeekCompletionSystemInstruction() },
      {
        role: "user",
        content: deepSeekCompletionUserPrompt(text, today, allowedPaymentMethods, base)
      }
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

export async function callDeepSeekEnrich(
  text,
  fixedFields,
  allowedCategories = ALLOWED_CATEGORIES,
  { timeoutMs = 15000, retries = 1 } = {}
) {
  if (!DEEPSEEK_API_KEY) throw new Error("Missing env var: DEEPSEEK_API_KEY");

  async function runOnce() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const payload = {
        model: "deepseek-chat",
        temperature: 0.2,
        messages: [
          { role: "system", content: deepSeekEnrichSystemInstruction() },
          {
            role: "user",
            content: deepSeekEnrichUserPrompt(text, fixedFields, allowedCategories)
          }
        ]
      };

      const res = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      const bodyText = await res.text();
      if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}: ${bodyText}`);

      const data = JSON.parse(bodyText);
      const out = data?.choices?.[0]?.message?.content || "";
      return extractJsonObject(out);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  try {
    return await runOnce();
  } catch (error) {
    if (retries > 0) {
      return runOnce();
    }
    throw error;
  }
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

  // básicos
  if (!isFinite(d.amount_mxn) || d.amount_mxn <= 0) {
    return { ok: false, error: "Monto inválido. Ej: 230 Uber BBVA Platino ayer" };
  }

  if (d.payment_method.toLowerCase() === "amex") {
    return { ok: false, error: "❌ 'Amex' es ambiguo. Usa: American Express o Amex Aeromexico." };
  }

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

  /* ===== MSI handling (modo conversacional) ===== */
  if (d.is_msi) {
    // total amount siempre debe existir: si no vino, usamos el monto del texto
    if (!isFinite(d.msi_total_amount) || d.msi_total_amount <= 0) {
      d.msi_total_amount = originalAmount;
    }

    // si NO vienen meses -> regresamos borrador parcial
    if (!isFinite(d.msi_months) || d.msi_months <= 1) {
      d.msi_months = null;
      d.msi_start_month = monthStartISO(d.purchase_date);
      // OJO: no tocamos amount_mxn aquí (sigue siendo el total)
      return { ok: false, needs_msi_months: true, draft: d };
    }

    // si SÍ vienen meses -> normalizamos amount_mxn a cashflow mensual
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.msi_start_month)) {
      d.msi_start_month = monthStartISO(d.purchase_date);
    }

    d.amount_mxn = round2(d.msi_total_amount / d.msi_months);
    return { ok: true, draft: d };
  }

  // NO MSI: limpia campos MSI por consistencia
  d.msi_months = null;
  d.msi_total_amount = null;
  d.msi_start_month = null;

  return { ok: true, draft: d };
}

export async function validateDeepSeekEnrich(
  obj,
  { allowedCategories = ALLOWED_CATEGORIES, allowedPaymentMethods } = {}
) {
  if (!obj || typeof obj !== "object") {
    return { ok: false, error: "Respuesta inválida del modelo." };
  }
  if (obj.error) return { ok: false, error: String(obj.error) };

  const category = String(obj.category || "").trim();
  const merchantRaw = obj.merchant == null ? "" : String(obj.merchant).trim();
  const descriptionRaw = obj.description == null ? "" : String(obj.description).trim();
  const isAllowedCategory = category && allowedCategories.includes(category);
  const categoryConfidence = isAllowedCategory ? (category === "Other" ? 0.4 : 0.9) : 0;
  const normalizedCategory =
    categoryConfidence >= CATEGORY_CONFIDENCE_THRESHOLD ? category : "Other";

  const trimmedMerchant = merchantRaw ? merchantRaw.slice(0, 80) : "";
  const description = descriptionRaw || "Gasto";

  let merchant = trimmedMerchant || null;
  if (merchant && allowedPaymentMethods?.includes(merchant)) {
    merchant = null;
  }

  return {
    ok: true,
    draft: {
      category: normalizedCategory,
      merchant,
      description,
      category_confidence: categoryConfidence
    }
  };
}

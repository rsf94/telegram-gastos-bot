import {
  DEEPSEEK_API_KEY,
  ALLOWED_PAYMENT_METHODS,
  ALLOWED_CATEGORIES
} from "./config.js";

import { todayISOInTZ } from "./parsing.js";

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
    JSON.stringify({
      error:
        "Explica qué falta o qué es ambiguo y qué debe aclarar el usuario."
    }),
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

export async function callDeepSeekParse(text) {
  if (!DEEPSEEK_API_KEY) throw new Error("Missing env var: DEEPSEEK_API_KEY");

  // ✅ CDMX: evita bug de UTC (toISOString) que te daba "mañana"
  const today = todayISOInTZ();

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

export function validateParsedFromAI(obj) {
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
    return {
      ok: false,
      error:
        "Método de pago inválido. Usa uno de:\n- " +
        ALLOWED_PAYMENT_METHODS.join("\n- ")
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
    return { ok: false, error: "Fecha inválida. Debe ser YYYY-MM-DD (ej. 2026-01-16)." };
  }

  if (!d.description) d.description = "Gasto";

  return { ok: true, draft: d };
}

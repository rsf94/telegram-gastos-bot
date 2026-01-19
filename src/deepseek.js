import { DEEPSEEK_API_KEY, ALLOWED_CATEGORIES } from "./config.js";
import { todayISOInTZ } from "./parsing.js";

/* =======================
 * Helpers
 * ======================= */
function extractJsonObject(text) {
  const m = (text || "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("No JSON object found in model output");
  return JSON.parse(m[0]);
}

/* =======================
 * DeepSeek prompts (categoría)
 * ======================= */
function deepSeekCategorySystemInstruction() {
  return [
    "Eres un clasificador de categoría de gastos.",
    "Devuelve SOLO JSON válido (sin backticks, sin texto extra).",
    "category debe ser EXACTAMENTE una de ALLOWED_CATEGORIES.",
    "No inventes.",
    "No devuelvas ningún otro campo.",
    "Si falta info o hay ambigüedad, devuelve {\"error\":\"...\"}."
  ].join(" ");
}

function deepSeekCategoryUserPrompt(text, todayISO) {
  return [
    "Clasifica la categoría del gasto.",
    `Hoy es: ${todayISO} (YYYY-MM-DD).`,
    "Texto del usuario:",
    text,
    "",
    "Devuelve SOLO JSON con una de estas dos formas:",
    "",
    "1) Éxito:",
    JSON.stringify({ category: "Other" }),
    "",
    "2) Error:",
    JSON.stringify({ error: "Explica la ambigüedad o lo que falta." }),
    "",
    "Categorías permitidas:",
    ALLOWED_CATEGORIES.join(" | ")
  ].join("\n");
}

/* =======================
 * Llamada a DeepSeek
 * ======================= */
export async function callDeepSeekCategory(
  text,
  todayISO = todayISOInTZ(),
  _allowedPaymentMethods = undefined
) {
  if (!DEEPSEEK_API_KEY) throw new Error("Missing env var: DEEPSEEK_API_KEY");

  const payload = {
    model: "deepseek-chat",
    temperature: 0.2,
    messages: [
      { role: "system", content: deepSeekCategorySystemInstruction() },
      { role: "user", content: deepSeekCategoryUserPrompt(text, todayISO) }
    ]
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);

  try {
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

/* =======================
 * Validación final
 * ======================= */
export function validateCategoryFromAI(obj) {
  if (obj?.error) return { ok: false, error: String(obj.error) };

  const category = String(obj?.category || "");
  if (!ALLOWED_CATEGORIES.includes(category)) {
    return {
      ok: false,
      error: "Categoría inválida. Debe ser una de tu lista (ej. Transport, Groceries, Restaurant)."
    };
  }

  return { ok: true, category };
}

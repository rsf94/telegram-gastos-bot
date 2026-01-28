import crypto from "crypto";
import {
  GEMINI_API_KEY,
  GEMINI_MODEL,
  DEEPSEEK_API_KEY,
  LLM_PROVIDER,
  LLM_FALLBACK,
  ALLOWED_CATEGORIES,
  ALLOWED_PAYMENT_METHODS
} from "./config.js";
import { cleanTextForDescription, todayISOInTZ } from "./parsing.js";
import { callDeepSeekEnrich, validateDeepSeekEnrich } from "./deepseek.js";

const CACHE_TTL_MS = 10 * 60 * 1000;
const llmCache = new Map();
const CATEGORY_CONFIDENCE_THRESHOLD = 0.6;

function buildCacheKey(text, baseDraft) {
  const paymentMethod = baseDraft?.payment_method || "";
  const purchaseDate = baseDraft?.purchase_date || "";
  const isMsi = baseDraft?.is_msi ? "1" : "0";
  const msiMonths = baseDraft?.msi_months ?? "";
  return crypto
    .createHash("sha256")
    .update(`${text || ""}||${paymentMethod}||${purchaseDate}||${isMsi}||${msiMonths}`)
    .digest("hex");
}

function getCachedEntry(key) {
  const entry = llmCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    llmCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCachedEntry(key, value) {
  llmCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function extractJsonObject(text) {
  const match = String(text || "").match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("No JSON object found in model output");
  }
  return JSON.parse(match[0]);
}

function buildFallback(text, baseDraft) {
  const amountToken = baseDraft?.__meta?.amount_tokens?.[0] || "";
  const cleaned = cleanTextForDescription(text, amountToken, baseDraft?.payment_method);
  return {
    category: "Other",
    merchant: "",
    description: cleaned || "Gasto"
  };
}

function buildPrompt({ text, todayISO }) {
  return [
    "Eres un asistente para completar datos de gastos.",
    "Devuelve UNICAMENTE JSON válido (sin backticks, sin texto extra).",
    "Solo debes responder con: category, merchant, description.",
    "NO inventes ni modifiques amount_mxn, payment_method, purchase_date ni MSI.",
    "",
    `Hoy es: ${todayISO} (YYYY-MM-DD).`,
    "",
    "Texto del usuario:",
    text,
    "",
    "Reglas:",
    "- category debe ser EXACTAMENTE una de las categorías permitidas.",
    "- merchant debe ser corto y limpio (ej. 'Uber', 'La Comer', 'Amazon').",
    "- description debe ser breve y útil.",
    "",
    "Categorías permitidas:",
    ALLOWED_CATEGORIES.join(" | "),
    "",
    "Devuelve SOLO JSON con esta forma:",
    JSON.stringify({
      category: "Transport",
      merchant: "Uber",
      description: "Viaje"
    })
  ].join("\n");
}

function normalizeCompletion(obj, { text, baseDraft } = {}) {
  if (!obj || typeof obj !== "object") {
    throw new Error("Respuesta inválida del modelo.");
  }

  const fallback = buildFallback(text || "", baseDraft);
  const category = String(obj.category || "").trim();
  const merchantRaw = obj.merchant == null ? "" : String(obj.merchant).trim();
  const descriptionRaw = obj.description == null ? "" : String(obj.description).trim();
  const isAllowedCategory = category && ALLOWED_CATEGORIES.includes(category);
  const categoryConfidence = isAllowedCategory ? (category === "Other" ? 0.4 : 0.9) : 0;
  const normalizedCategory =
    categoryConfidence >= CATEGORY_CONFIDENCE_THRESHOLD ? category : "Other";
  const merchant = merchantRaw ? merchantRaw.slice(0, 80) : "";
  const description = descriptionRaw || fallback.description || "Gasto";

  return {
    category: normalizedCategory,
    merchant,
    description,
    category_confidence: categoryConfidence
  };
}

async function requestGemini(prompt, { timeoutMs }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const model = GEMINI_MODEL || "gemini-3-flash-preview";

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2 }
        }),
        signal: controller.signal
      }
    );

    const bodyText = await res.text();
    if (!res.ok) {
      const trimmedBody = bodyText.slice(0, 2000);
      console.warn(
        `Gemini error response model=${model} HTTP ${res.status}: ${trimmedBody}`
      );
      throw new Error(`Gemini HTTP ${res.status} model=${model}`);
    }

    const data = JSON.parse(bodyText);
    const text =
      data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";

    return extractJsonObject(text);
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function callGeminiComplete({
  text,
  todayISO = todayISOInTZ(),
  baseDraft
}) {
  if (!GEMINI_API_KEY) {
    throw new Error("Missing env var: GEMINI_API_KEY");
  }

  const prompt = buildPrompt({ text, todayISO });
  const timeoutMs = 4000;

  const raw = await requestGemini(prompt, { timeoutMs });
  return normalizeCompletion(raw, { text, baseDraft });
}

function shortError(error) {
  const msg = error?.message || String(error || "");
  return msg.split("\n")[0].slice(0, 180);
}

function resolveFallbackPreference() {
  if (LLM_FALLBACK) return String(LLM_FALLBACK).toLowerCase();
  return DEEPSEEK_API_KEY ? "deepseek" : "none";
}

export async function enrichExpenseLLM({ text, todayISO = todayISOInTZ(), baseDraft }) {
  const cacheKey = buildCacheKey(text, baseDraft);
  const cached = getCachedEntry(cacheKey);
  if (cached) return { ...cached, cache_hit: true };

  const fallback = { ...buildFallback(text, baseDraft), llm_provider: "local" };
  const provider = String(LLM_PROVIDER || "gemini").toLowerCase();

  if (provider !== "gemini") {
    setCachedEntry(cacheKey, fallback);
    return { ...fallback, cache_hit: false };
  }

  try {
    const completion = await callGeminiComplete({ text, todayISO, baseDraft });
    const result = { ...completion, llm_provider: "gemini" };
    setCachedEntry(cacheKey, result);
    return { ...result, cache_hit: false };
  } catch (error) {
    const fallbackPref = resolveFallbackPreference();
    if (fallbackPref === "deepseek" && DEEPSEEK_API_KEY) {
      const start = Date.now();
      try {
        const fixedFields = {
          amount_mxn: baseDraft?.amount_mxn,
          payment_method: baseDraft?.payment_method,
          purchase_date: baseDraft?.purchase_date
        };
        const ai = await callDeepSeekEnrich(text, fixedFields, ALLOWED_CATEGORIES);
        const validation = await validateDeepSeekEnrich(ai, {
          allowedCategories: ALLOWED_CATEGORIES,
          allowedPaymentMethods: ALLOWED_PAYMENT_METHODS
        });
        if (!validation.ok) {
          throw new Error(validation.error);
        }
        const durationMs = Date.now() - start;
        console.warn(
          `LLM fallback=deepseek durationMs=${durationMs} error=${shortError(error)}`
        );
        const result = { ...validation.draft, llm_provider: "deepseek" };
        setCachedEntry(cacheKey, result);
        return { ...result, cache_hit: false };
      } catch (deepseekError) {
        const durationMs = Date.now() - start;
        console.warn(
          `LLM fallback=local durationMs=${durationMs} error=${shortError(deepseekError)}`
        );
        setCachedEntry(cacheKey, fallback);
        return { ...fallback, cache_hit: false };
      }
    }

    console.warn(`LLM fallback=local durationMs=0 error=${shortError(error)}`);
    setCachedEntry(cacheKey, fallback);
    return { ...fallback, cache_hit: false };
  }
}

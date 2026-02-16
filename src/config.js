export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3-flash-preview";
export const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
export const LLM_PROVIDER = process.env.LLM_PROVIDER || "gemini";
export const LLM_FALLBACK = process.env.LLM_FALLBACK;

export const BQ_PROJECT_ID = process.env.BQ_PROJECT_ID || "project-c9256c63-847c-4b18-ac8";
export const BQ_DATASET = process.env.BQ_DATASET || "gastos";
export const BQ_TABLE = process.env.BQ_TABLE || "expenses";
export const BQ_ENRICHMENT_RETRY_TABLE =
  process.env.BQ_ENRICHMENT_RETRY_TABLE || "enrichment_retry";
export const DASHBOARD_BASE_URL = process.env.DASHBOARD_BASE_URL;
export const LINK_TOKEN_SECRET = process.env.LINK_TOKEN_SECRET;
export const FX_BASE_URL = process.env.FX_BASE_URL || "https://api.frankfurter.dev/v1";

export const ALLOWED_PAYMENT_METHODS = [
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

export const ALLOWED_CATEGORIES = [
  "Car maintenance","Car payment","TAG","Clothing","Condo fees","Debt","E-commerce",
  "Entertainment","Gas","Gifts","Going out","Groceries","Gym","Home maintenance",
  "Insurance","Medical","Mortgage","Other","Public transportation","Rent","Restaurant",
  "Telecom","Travel","Utilities","Work","Beauty & Self Care","Transport",
  "Subscriptions","Savings"
];

export function warnMissingEnv() {
  if (!TELEGRAM_BOT_TOKEN) console.warn("Missing env var: TELEGRAM_BOT_TOKEN");
  if (!GEMINI_API_KEY) {
    console.warn("Missing env var: GEMINI_API_KEY (Gemini completion will fallback)");
  }
  if (LLM_PROVIDER === "gemini" && LLM_FALLBACK === "deepseek" && !DEEPSEEK_API_KEY) {
    console.warn("Missing env var: DEEPSEEK_API_KEY (DeepSeek fallback unavailable)");
  }
  if (!DASHBOARD_BASE_URL) console.warn("Missing env var: DASHBOARD_BASE_URL");
  if (!LINK_TOKEN_SECRET) console.warn("Missing env var: LINK_TOKEN_SECRET");
}

export function validateEnv() {
  const missing = [];

  if (!TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
  if (!process.env.CRON_TOKEN) missing.push("CRON_TOKEN");
  if (!BQ_PROJECT_ID) missing.push("BQ_PROJECT_ID");
  if (!BQ_DATASET) missing.push("BQ_DATASET");
  if (!BQ_TABLE) missing.push("BQ_TABLE");
  if (!DASHBOARD_BASE_URL) missing.push("DASHBOARD_BASE_URL");
  if (!LINK_TOKEN_SECRET) missing.push("LINK_TOKEN_SECRET");

  if (LLM_PROVIDER === "gemini" && !GEMINI_API_KEY) {
    missing.push("GEMINI_API_KEY (required for LLM_PROVIDER=gemini)");
  }
  if (LLM_PROVIDER === "deepseek" && !DEEPSEEK_API_KEY) {
    missing.push("DEEPSEEK_API_KEY (required for LLM_PROVIDER=deepseek)");
  }
  if (LLM_PROVIDER === "gemini" && LLM_FALLBACK === "deepseek" && !DEEPSEEK_API_KEY) {
    missing.push("DEEPSEEK_API_KEY (required for LLM_FALLBACK=deepseek)");
  }

  if (missing.length) {
    throw new Error(
      `Missing required env vars: ${missing.join(", ")}. ` +
        "Set them before starting the server."
    );
  }
}

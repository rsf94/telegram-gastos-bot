export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

export const BQ_PROJECT_ID = process.env.BQ_PROJECT_ID || "project-c9256c63-847c-4b18-ac8";
export const BQ_DATASET = process.env.BQ_DATASET || "gastos";
export const BQ_TABLE = process.env.BQ_TABLE || "expenses";

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
  if (!DEEPSEEK_API_KEY) console.warn("Missing env var: DEEPSEEK_API_KEY (DeepSeek parse will fail and fallback to naive)");
}

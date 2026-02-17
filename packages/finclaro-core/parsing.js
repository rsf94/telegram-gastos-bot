const DEFAULT_ALLOWED_PAYMENT_METHODS = [
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

const DEFAULT_ALLOWED_CATEGORIES = [
  "Car maintenance","Car payment","TAG","Clothing","Condo fees","Debt","E-commerce",
  "Entertainment","Gas","Gifts","Going out","Groceries","Gym","Home maintenance",
  "Insurance","Medical","Mortgage","Other","Public transportation","Rent","Restaurant",
  "Telecom","Travel","Utilities","Work","Beauty & Self Care","Transport",
  "Subscriptions","Savings"
];

export const APP_TZ = "America/Mexico_City";

export function todayISOInTZ(tz = APP_TZ) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

export function minusDaysISOFromTZDate(yyyy_mm_dd, days) {
  const [y, m, d] = yyyy_mm_dd.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  base.setUTCDate(base.getUTCDate() - days);
  return base.toISOString().slice(0, 10);
}

export function overrideRelativeDate(text, currentISO) {
  const t = (text || "").toLowerCase();
  const explicit = (text.match(/\b\d{4}-\d{2}-\d{2}\b/) || [])[0];
  if (explicit) return explicit;

  const today = todayISOInTZ();

  if (/\bantier\b|\banteayer\b/.test(t)) return minusDaysISOFromTZDate(today, 2);
  if (/\bayer\b/.test(t)) return minusDaysISOFromTZDate(today, 1);
  if (/\bhoy\b/.test(t)) return today;

  return currentISO;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

const DEFAULT_SUPPORTED_CURRENCIES = new Set([
  "MXN", "USD", "EUR", "JPY", "GBP", "CAD", "AUD", "CHF", "BRL", "COP", "ARS", "CLP", "PEN"
]);

function buildSupportedCurrenciesSet() {
  const intlFn = Intl?.supportedValuesOf;
  if (typeof intlFn !== "function") return DEFAULT_SUPPORTED_CURRENCIES;
  try {
    const currencies = intlFn("currency")
      .map((code) => String(code || "").toUpperCase())
      .filter((code) => /^[A-Z]{3}$/.test(code));
    return currencies.length ? new Set(currencies) : DEFAULT_SUPPORTED_CURRENCIES;
  } catch (_) {
    return DEFAULT_SUPPORTED_CURRENCIES;
  }
}

const SUPPORTED_CURRENCIES = buildSupportedCurrenciesSet();

function extractCurrencyCode(text) {
  const tokens = String(text || "").match(/\b[A-Za-z]{3}\b/g) || [];
  for (const token of tokens) {
    const upper = token.toUpperCase();
    if (upper === "MSI") continue;
    if (SUPPORTED_CURRENCIES.has(upper)) return upper;
  }
  return null;
}

function normalizeAmountToken(token) {
  if (!token) return NaN;
  const raw = token.replace(/\s+/g, "");
  const hasDot = raw.includes(".");
  const hasComma = raw.includes(",");

  let cleaned = raw;
  if (hasDot && hasComma) {
    cleaned = raw.replace(/,/g, "");
  } else if (hasComma && !hasDot) {
    const parts = raw.split(",");
    if (parts[parts.length - 1].length === 2) {
      cleaned = parts.slice(0, -1).join("") + "." + parts[parts.length - 1];
    } else {
      cleaned = raw.replace(/,/g, "");
    }
  }

  return Number(cleaned);
}

function extractAmountTokens(text) {
  const withoutDates = String(text || "").replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ");
  const matches = [...withoutDates.matchAll(/\$?\s*(\d[\d.,]*)/g)];
  return matches.map((m) => m[1]).filter((token) => token && token.replace(/[.,]/g, "").length > 0);
}

function cleanDescription(text, tokensToRemove) {
  let result = String(text || "");
  tokensToRemove.forEach((token) => {
    if (!token) return;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "gi"), " ");
  });

  result = result
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .replace(/\b(hoy|ayer|antier|anteayer)\b/gi, " ")
    .replace(/\b(msi|meses?\s+sin\s+intereses?)\b/gi, " ");

  return result.replace(/\s+/g, " ").trim();
}

export function cleanTextForDescription(text, amountToken, paymentMethod) {
  const tokensToRemove = [];
  if (amountToken) tokensToRemove.push(amountToken);
  if (paymentMethod) tokensToRemove.push(paymentMethod);
  return cleanDescription(text, tokensToRemove);
}

function normalizeForCategory(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const CATEGORY_RULES = [
  { pattern: /\b(uber|didi|parco|estacionamiento)\b/, category: "Transport" },
  { pattern: /\b(la comer|lacom(er)?|city market|chedraui|costco|walmart)\b/, category: "Groceries" },
  { pattern: /\b(amazon|mercado libre|temu|microsoft|apple)\b/, category: "E-commerce" },
  { pattern: /\b(spotify|netflix|chatgpt|subscription)\b/, category: "Subscriptions" },
  { pattern: /\b(telmex|telcel)\b/, category: "Telecom" },
  { pattern: /\bplanet fitness\b/, category: "Gym" },
  { pattern: /\bcfe\b/, category: "Utilities" },
  { pattern: /\b(interceramic|aliada|honesta|zolver)\b/, category: "Home maintenance" },
  { pattern: /\b(pemex|gasolinera|corpogas|max gass|gasolina)\b/, category: "Gas" },
  { pattern: /\b(farmacia san pablo|medify|nutriologa)\b/, category: "Medical" },
  { pattern: /\b(toks|termini|crepes and waffles|pizza felix|peltre|pampas|asturiano|restaurante)\b/, category: "Restaurant" },
  { pattern: /\b(viva aerobus|aifa|travelers rewards|nyc)\b/, category: "Travel" },
  { pattern: /\b(palacio de hierro|liverpool|promoda)\b/, category: "Clothing" }
];

const MERCHANT_RULES = [
  { pattern: /\buber\b/, merchant: "Uber" }, { pattern: /\bdidi\b/, merchant: "Didi" },
  { pattern: /\bparco\b/, merchant: "Parco" }, { pattern: /\bestacionamiento\b/, merchant: "Estacionamiento" },
  { pattern: /\bla comer|lacom(er)?\b/, merchant: "La Comer" }, { pattern: /\bcity market\b/, merchant: "City Market" },
  { pattern: /\bchedraui\b/, merchant: "Chedraui" }, { pattern: /\bcostco\b/, merchant: "Costco" },
  { pattern: /\bwalmart\b/, merchant: "Walmart" }, { pattern: /\bamazon\b/, merchant: "Amazon" },
  { pattern: /\bmercado libre\b/, merchant: "Mercado Libre" }, { pattern: /\btemu\b/, merchant: "Temu" },
  { pattern: /\bmicrosoft\b/, merchant: "Microsoft" }, { pattern: /\bapple\b/, merchant: "Apple" },
  { pattern: /\bspotify\b/, merchant: "Spotify" }, { pattern: /\bnetflix\b/, merchant: "Netflix" },
  { pattern: /\bchatgpt\b/, merchant: "ChatGPT" }, { pattern: /\btelmex\b/, merchant: "Telmex" },
  { pattern: /\btelcel\b/, merchant: "Telcel" }, { pattern: /\bplanet fitness\b/, merchant: "Planet Fitness" },
  { pattern: /\bcfe\b/, merchant: "CFE" }, { pattern: /\binterceramic\b/, merchant: "Interceramic" },
  { pattern: /\baliada\b/, merchant: "Aliada" }, { pattern: /\bhonesta\b/, merchant: "Honesta" },
  { pattern: /\bzolver\b/, merchant: "Zolver" }, { pattern: /\bpemex\b/, merchant: "Pemex" },
  { pattern: /\bgasolinera\b/, merchant: "Gasolinera" }, { pattern: /\bcorpogas\b/, merchant: "Corpogas" },
  { pattern: /\bmax gass\b/, merchant: "Max Gass" }, { pattern: /\bfarmacia san pablo\b/, merchant: "Farmacia San Pablo" },
  { pattern: /\bmedify\b/, merchant: "Medify" }, { pattern: /\bnutriologa\b/, merchant: "Nutrióloga" },
  { pattern: /\btoks\b/, merchant: "Toks" }, { pattern: /\btermini\b/, merchant: "Termini" },
  { pattern: /\bcrepes and waffles\b/, merchant: "Crepes & Waffles" }, { pattern: /\bpizza felix\b/, merchant: "Pizza Felix" },
  { pattern: /\bpeltre\b/, merchant: "Peltre" }, { pattern: /\bpampas\b/, merchant: "Pampas" },
  { pattern: /\basturiano\b/, merchant: "Asturiano" }, { pattern: /\bviva aerobus\b/, merchant: "Viva Aerobus" },
  { pattern: /\baifa\b/, merchant: "AIFA" }, { pattern: /\btravelers rewards\b/, merchant: "Travelers Rewards" },
  { pattern: /\bnyc\b/, merchant: "NYC" }, { pattern: /\bpalacio de hierro\b/, merchant: "Palacio de Hierro" },
  { pattern: /\bliverpool\b/, merchant: "Liverpool" }, { pattern: /\bpromoda\b/, merchant: "Promoda" }
];

export function guessCategory(text, { allowedCategories = DEFAULT_ALLOWED_CATEGORIES } = {}) {
  const normalized = normalizeForCategory(text);
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(normalized)) {
      return allowedCategories.includes(rule.category) ? rule.category : "Other";
    }
  }
  return "Other";
}

export function guessMerchant(text) {
  const normalized = normalizeForCategory(text);
  for (const rule of MERCHANT_RULES) {
    if (rule.pattern.test(normalized)) return rule.merchant;
  }
  return "";
}

export function localParseExpense(text, { allowedPaymentMethods = DEFAULT_ALLOWED_PAYMENT_METHODS } = {}) {
  const raw = String(text || "");
  const lower = raw.toLowerCase();
  const today = todayISOInTZ();

  const amountTokens = extractAmountTokens(raw);
  const amounts = amountTokens.map((token) => normalizeAmountToken(token)).filter((n) => Number.isFinite(n) && n > 0);
  const amount_mxn = amounts.length ? amounts[0] : NaN;

  const paymentMatches = allowedPaymentMethods.filter((method) => lower.includes(method.toLowerCase()));
  const payment_method = paymentMatches.length ? paymentMatches.sort((a, b) => b.length - a.length)[0] : "";

  const amex_ambiguous = /\bamex\b/.test(lower) && !payment_method;
  const purchase_date = overrideRelativeDate(raw, today);

  const is_msi = /\bmsi\b|meses?\s+sin\s+intereses?/.test(lower);
  let msi_months = null;
  const msiMatch = lower.match(/(\d{1,2})\s*msi\b|\ba\s*(\d{1,2})\s*msi\b/);
  if (msiMatch) {
    const n = Number(msiMatch[1] || msiMatch[2]);
    if (Number.isFinite(n) && n > 1 && n <= 60) msi_months = n;
  }

  const msi_total_amount = is_msi && Number.isFinite(amount_mxn) ? amount_mxn : null;
  const parsedCurrency = extractCurrencyCode(raw);

  return {
    amount_mxn,
    currency: parsedCurrency || "MXN",
    currency_explicit: Boolean(parsedCurrency),
    payment_method,
    category: "Other",
    purchase_date,
    merchant: "",
    description: "",
    is_msi,
    msi_months,
    msi_total_amount,
    msi_start_month: null,
    amex_ambiguous,
    __meta: {
      amount_tokens: amountTokens,
      amounts_found: amounts.length,
      has_multiple_amounts: amounts.length > 1
    }
  };
}

export function naiveParse(text, { allowedPaymentMethods = DEFAULT_ALLOWED_PAYMENT_METHODS } = {}) {
  const parsedCurrency = extractCurrencyCode(text);
  const m = text.match(/(\d+(\.\d+)?)/);
  const amount = m ? Number(m[1]) : NaN;
  const amex_ambiguous = /\bamex\b/.test(String(text || "").toLowerCase());
  const pm = allowedPaymentMethods.find((x) => text.toLowerCase().includes(x.toLowerCase())) || "";
  const d = (text.match(/\b\d{4}-\d{2}-\d{2}\b/) || [])[0];
  const today = todayISOInTZ();
  const desc = text.replace(m ? m[0] : "", "").trim();
  const low = (text || "").toLowerCase();
  const is_msi = /\bmsi\b|meses\s+sin\s+intereses/.test(low);
  let msi_months = null;
  const mm = low.match(/(\d{1,2})\s*msi\b/);
  if (mm) msi_months = Number(mm[1]);
  const msi_total_amount = is_msi && isFinite(amount) ? amount : null;
  const monthly = is_msi && isFinite(msi_total_amount) && isFinite(msi_months) && msi_months > 1
    ? round2(msi_total_amount / msi_months)
    : amount;

  return {
    amount_mxn: monthly,
    currency: parsedCurrency || "MXN",
    currency_explicit: Boolean(parsedCurrency),
    payment_method: pm,
    category: "Other",
    purchase_date: d || today,
    merchant: "",
    description: desc || "Gasto",
    amex_ambiguous,
    is_msi,
    msi_months,
    msi_total_amount,
    msi_start_month: null,
    __meta: {
      amount_tokens: m ? [m[1]] : [],
      amounts_found: m ? 1 : 0,
      has_multiple_amounts: false
    }
  };
}

export function validateDraft(d, {
  skipPaymentMethod = false,
  allowedPaymentMethods = DEFAULT_ALLOWED_PAYMENT_METHODS,
  allowedCategories = DEFAULT_ALLOWED_CATEGORIES
} = {}) {
  if (d?.is_msi === true) {
    if (!isFinite(d.msi_total_amount) || d.msi_total_amount <= 0) {
      return "❌ MSI detectado pero falta el monto total. Ej: 1200 gasolinera MSI BBVA Platino";
    }
    if (d.msi_months != null) {
      const n = Number(d.msi_months);
      if (!Number.isFinite(n) || n <= 1 || n > 60) {
        return "❌ Meses MSI inválidos. Ej: 6, 12, 18, 24.";
      }
    }
  } else if (!isFinite(d.amount_mxn) || d.amount_mxn <= 0) {
    return "❌ Monto inválido. Ej: 230 Uber American Express ayer";
  }

  if (!skipPaymentMethod) {
    if (!d.payment_method) {
      if (d.amex_ambiguous || (d.description || "").toLowerCase().includes("amex")) {
        return "❌ 'Amex' es ambiguo. Usa: American Express o Amex Aeromexico.";
      }
      return "❌ Método de pago inválido. Usa uno de:\n- " + allowedPaymentMethods.join("\n- ");
    }
    if (!allowedPaymentMethods.includes(d.payment_method)) {
      return "❌ Método de pago inválido. Usa uno de:\n- " + allowedPaymentMethods.join("\n- ");
    }
  }

  if (!allowedCategories.includes(d.category)) d.category = "Other";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.purchase_date)) return "❌ Fecha inválida. Usa YYYY-MM-DD.";
  return null;
}

export function parseExpenseText(text, options = {}) {
  const parsed = localParseExpense(text, options);
  if (!isFinite(parsed.amount_mxn) || parsed.amount_mxn <= 0) {
    return naiveParse(text, options);
  }
  return parsed;
}

export { DEFAULT_ALLOWED_CATEGORIES, DEFAULT_ALLOWED_PAYMENT_METHODS, round2 };

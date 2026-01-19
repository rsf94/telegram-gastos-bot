import { ALLOWED_PAYMENT_METHODS, ALLOWED_CATEGORIES } from "./config.js";
import { escapeHtml } from "./telegram.js";

/**
 * Timezone app (CDMX) para evitar el bug de "mañana" por usar UTC (toISOString).
 */
export const APP_TZ = "America/Mexico_City";

/**
 * Devuelve YYYY-MM-DD usando la zona horaria indicada (default CDMX).
 * (en-CA formatea como YYYY-MM-DD)
 */
export function todayISOInTZ(tz = APP_TZ) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

/**
 * Resta días a una fecha YYYY-MM-DD de forma estable.
 * Usamos 12:00 UTC para evitar saltos raros por horario.
 */
export function minusDaysISOFromTZDate(yyyy_mm_dd, days) {
  const [y, m, d] = yyyy_mm_dd.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)); // 12:00 UTC
  base.setUTCDate(base.getUTCDate() - days);
  return base.toISOString().slice(0, 10);
}

/**
 * Sobrescribe la fecha si detecta "hoy/ayer/antier" (o anteayer).
 * Si hay fecha explícita YYYY-MM-DD, se respeta.
 */
export function overrideRelativeDate(text, currentISO) {
  const t = (text || "").toLowerCase();

  // si el usuario pone una fecha explícita YYYY-MM-DD, respétala
  const explicit = (text.match(/\b\d{4}-\d{2}-\d{2}\b/) || [])[0];
  if (explicit) return explicit;

  const today = todayISOInTZ(); // CDMX

  if (/\bantier\b|\banteayer\b/.test(t)) return minusDaysISOFromTZDate(today, 2);
  if (/\bayer\b/.test(t)) return minusDaysISOFromTZDate(today, 1);
  if (/\bhoy\b/.test(t)) return today;

  return currentISO;
}

/* =======================
 * Helpers MSI / money
 * ======================= */
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function monthStartISO(yyyyMmDd) {
  // yyyyMmDd = YYYY-MM-DD -> YYYY-MM-01
  return `${String(yyyyMmDd).slice(0, 7)}-01`;
}

function formatMoneyMXN(n) {
  const x = Number(n || 0);
  return x.toLocaleString("es-MX", { style: "currency", currency: "MXN" });
}

/* =======================
 * Naive parse (fallback)
 * - sigue simple, pero detecta "msi" básico
 * ======================= */
export function naiveParse(text) {
  const m = text.match(/(\d+(\.\d+)?)/);
  const amount = m ? Number(m[1]) : NaN;

  const pm =
    ALLOWED_PAYMENT_METHODS.find((x) =>
      text.toLowerCase().includes(x.toLowerCase())
    ) || "";

  const category = "Other";

  const d = (text.match(/\b\d{4}-\d{2}-\d{2}\b/) || [])[0];
  const today = todayISOInTZ(); // CDMX

  const desc = text.replace(m ? m[0] : "", "").trim();

  // MSI detect súper simple en fallback
  const low = (text || "").toLowerCase();
  const is_msi = /\bmsi\b|meses\s+sin\s+intereses/.test(low);

  // intenta sacar "6" en "6MSI" / "6 MSI"
  let msi_months = null;
  const mm = low.match(/(\d{1,2})\s*msi\b/);
  if (mm) msi_months = Number(mm[1]);

  // en naive: asumimos que el monto escrito es total si es MSI
  const msi_total_amount = is_msi && isFinite(amount) ? amount : null;

  // mensualidad si ya sabemos meses
  const monthly =
    is_msi && isFinite(msi_total_amount) && isFinite(msi_months) && msi_months > 1
      ? round2(msi_total_amount / msi_months)
      : amount;

  return {
    amount_mxn: monthly,
    payment_method: pm,
    category,
    purchase_date: d || today,
    merchant: "",
    description: desc || "Gasto",

    // MSI fields
    is_msi,
    msi_months,
    msi_total_amount,
    msi_start_month: is_msi ? monthStartISO(d || today) : null
  };
}

/* =======================
 * Local fast parse (local-first)
 * ======================= */
function extractFirstAmount(text) {
  const match = String(text || "").match(
    /(\d{1,3}(?:[\s,]\d{3})*(?:[.,]\d+)?|\d+(?:[.,]\d+)?)/
  );
  if (!match) return NaN;
  const raw = match[1].replace(/\s/g, "");
  if (raw.includes(",") && raw.includes(".")) {
    return Number(raw.replace(/,/g, ""));
  }
  if (raw.includes(",")) {
    return Number(raw.replace(",", "."));
  }
  return Number(raw);
}

function findPaymentMethod(text, allowedMethods) {
  const lower = String(text || "").toLowerCase();
  const sorted = [...allowedMethods].sort((a, b) => b.length - a.length);
  return (
    sorted.find((method) => lower.includes(method.toLowerCase())) || ""
  );
}

function extractExplicitDate(text) {
  return (String(text || "").match(/\b\d{4}-\d{2}-\d{2}\b/) || [])[0] || "";
}

function stripNoise(text, parts) {
  let out = String(text || "");
  for (const part of parts) {
    if (!part) continue;
    out = out.replace(part, " ");
  }
  out = out
    .replace(/\b(msi|meses\s+sin\s+intereses)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return out;
}

export function localParse(text, allowedMethods = ALLOWED_PAYMENT_METHODS) {
  const amount = extractFirstAmount(text);
  const payment_method = findPaymentMethod(text, allowedMethods);
  const today = todayISOInTZ();
  const explicitDate = extractExplicitDate(text);
  const purchase_date = overrideRelativeDate(text, explicitDate || today);

  const lower = String(text || "").toLowerCase();
  const is_msi = /\bmsi\b|\bmeses\s+sin\s+intereses\b/.test(lower);

  const cleaned = stripNoise(text, [
    explicitDate,
    payment_method,
    String(amount)
  ]);

  return {
    amount_mxn: amount,
    payment_method,
    category: "Other",
    purchase_date,
    merchant: "",
    description: cleaned || "Gasto",
    is_msi,
    msi_months: null,
    msi_total_amount: is_msi && isFinite(amount) ? Number(amount) : null,
    msi_start_month: is_msi ? monthStartISO(purchase_date) : null,
    __local: {
      descriptionText: cleaned,
      explicitDate
    }
  };
}

/* =======================
 * Validate draft (incluye MSI)
 * ======================= */
export function validateDraft(d, allowedMethods = ALLOWED_PAYMENT_METHODS) {
  // Si es MSI y faltan meses, NO lo marques como error duro:
  // tu index.js ya tiene el flujo para pedir "¿a cuántos meses?"
  if (d?.is_msi === true) {
    // monto total debe existir
    if (!isFinite(d.msi_total_amount) || d.msi_total_amount <= 0) {
      return "❌ MSI detectado pero falta el monto total. Ej: 1200 gasolinera MSI BBVA Platino";
    }
    // meses pueden faltar (se preguntan), pero si vienen deben ser válidos
    if (d.msi_months != null) {
      const n = Number(d.msi_months);
      if (!Number.isFinite(n) || n <= 1 || n > 60) {
        return "❌ Meses MSI inválidos. Ej: 6, 12, 18, 24.";
      }
    }
  } else {
    if (!isFinite(d.amount_mxn) || d.amount_mxn <= 0) {
      return "❌ Monto inválido. Ej: 230 Uber American Express ayer";
    }
  }

  if (!d.payment_method) {
    if ((d.description || "").toLowerCase().includes("amex")) {
      return "❌ 'Amex' es ambiguo. Usa: American Express o Amex Aeromexico.";
    }
    return (
      "❌ Método de pago inválido. Usa uno de:\n- " +
      allowedMethods.join("\n- ")
    );
  }

  if (!ALLOWED_CATEGORIES.includes(d.category)) d.category = "Other";

  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.purchase_date)) {
    return "❌ Fecha inválida. Usa YYYY-MM-DD.";
  }

  return null;
}

/* =======================
 * Preview (MSI-friendly)
 * ======================= */
export function preview(d) {
  const lines = ["🧾 <b>Confirmar gasto</b>"];

  const isMsi = d?.is_msi === true;

  if (isMsi) {
    const total = Number(d.msi_total_amount || 0);
    const months = d.msi_months != null ? Number(d.msi_months) : null;

    lines.push(`Tipo: <b>MSI</b>`);
    lines.push(`Total compra: <b>${escapeHtml(formatMoneyMXN(total))}</b>`);

    if (!months || !Number.isFinite(months) || months <= 1) {
      lines.push(`Meses: <b>❓ (falta)</b>`);
      lines.push(`Mensualidad: <b>—</b>`);
    } else {
      const monthly = isFinite(d.amount_mxn) && d.amount_mxn > 0
        ? Number(d.amount_mxn)
        : round2(total / months);
      lines.push(`Meses: <b>${escapeHtml(String(months))}</b>`);
      lines.push(`Mensualidad aprox: <b>${escapeHtml(formatMoneyMXN(monthly))}</b>`);
    }

    const sm = d.msi_start_month || monthStartISO(d.purchase_date);
    lines.push(`Mes de inicio: <b>${escapeHtml(sm)}</b>`);
  } else {
    lines.push(`Monto: <b>${escapeHtml(formatMoneyMXN(d.amount_mxn))}</b>`);
  }

  lines.push(`Método: <b>${escapeHtml(d.payment_method)}</b>`);
  lines.push(`Fecha: <b>${escapeHtml(d.purchase_date)}</b>`);
  lines.push(`Categoría: <b>${escapeHtml(d.category)}</b>`);
  lines.push(`Descripción: ${escapeHtml(d.description)}`);
  if (d.merchant) lines.push(`Comercio: ${escapeHtml(d.merchant)}`);

  lines.push("", "Toca un botón:");
  return lines.join("\n");
}

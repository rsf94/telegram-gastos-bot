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

  return {
    amount_mxn: amount,
    payment_method: pm,
    category,
    purchase_date: d || today,
    merchant: "",
    description: desc || "Gasto"
  };
}

export function validateDraft(d) {
  if (!isFinite(d.amount_mxn) || d.amount_mxn <= 0) {
    return "❌ Monto inválido. Ej: 230 Uber American Express ayer";
  }

  if (!d.payment_method) {
    if ((d.description || "").toLowerCase().includes("amex")) {
      return "❌ 'Amex' es ambiguo. Usa: American Express o Amex Aeromexico.";
    }
    return (
      "❌ Método de pago inválido. Usa uno de:\n- " +
      ALLOWED_PAYMENT_METHODS.join("\n- ")
    );
  }

  if (!ALLOWED_CATEGORIES.includes(d.category)) d.category = "Other";

  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.purchase_date)) {
    return "❌ Fecha inválida. Usa YYYY-MM-DD.";
  }

  return null;
}

export function preview(d) {
  const lines = [
    "🧾 <b>Confirmar gasto</b>",
    `Monto: <b>$${Math.round(d.amount_mxn)} MXN</b>`,
    `Método: <b>${escapeHtml(d.payment_method)}</b>`,
    `Fecha: <b>${escapeHtml(d.purchase_date)}</b>`,
    `Categoría: <b>${escapeHtml(d.category)}</b>`,
    `Descripción: ${escapeHtml(d.description)}`
  ];
  if (d.merchant) lines.push(`Comercio: ${escapeHtml(d.merchant)}`);
  lines.push("", "Toca un botón:");
  return lines.join("\n");
}

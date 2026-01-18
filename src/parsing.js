import { ALLOWED_PAYMENT_METHODS, ALLOWED_CATEGORIES } from "./config.js";
import { escapeHtml } from "./telegram.js";

export function minusDaysISO(todayISO, days) {
  const d = new Date(todayISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function overrideRelativeDate(text, currentISO) {
  const t = (text || "").toLowerCase();

  const explicit = (text.match(/\b\d{4}-\d{2}-\d{2}\b/) || [])[0];
  if (explicit) return explicit;

  const todayISO = new Date().toISOString().slice(0, 10);

  if (/\bantier\b|\banteayer\b/.test(t)) return minusDaysISO(todayISO, 2);
  if (/\bayer\b/.test(t)) return minusDaysISO(todayISO, 1);
  if (/\bhoy\b/.test(t)) return todayISO;

  return currentISO;
}

export function naiveParse(text) {
  const m = text.match(/(\d+(\.\d+)?)/);
  const amount = m ? Number(m[1]) : NaN;

  const pm = ALLOWED_PAYMENT_METHODS.find(x => text.toLowerCase().includes(x.toLowerCase())) || "";
  const category = "Other";

  const d = (text.match(/\b\d{4}-\d{2}-\d{2}\b/) || [])[0];
  const today = new Date().toISOString().slice(0, 10);

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
    return "❌ Método de pago inválido. Usa uno de:\n- " + ALLOWED_PAYMENT_METHODS.join("\n- ");
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

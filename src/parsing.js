import { ALLOWED_PAYMENT_METHODS, ALLOWED_CATEGORIES } from "./config.js";
import { escapeHtml } from "./telegram.js";
import {
  APP_TZ,
  todayISOInTZ,
  minusDaysISOFromTZDate,
  overrideRelativeDate,
  cleanTextForDescription,
  guessCategory as coreGuessCategory,
  guessMerchant,
  localParseExpense as coreLocalParseExpense,
  naiveParse as coreNaiveParse,
  validateDraft as coreValidateDraft
} from "finclaro-core";

function formatAmountWithCurrency(amount, currency = "MXN") {
  return `${Number(amount || 0)} ${String(currency || "MXN").toUpperCase()}`;
}

function formatDraftAmount(draft) {
  return formatAmountWithCurrency(draft?.amount_mxn, draft?.currency || "MXN");
}

function formatMoney(value, { minimumFractionDigits = 0, maximumFractionDigits = 2 } = {}) {
  return new Intl.NumberFormat("es-MX", {
    minimumFractionDigits,
    maximumFractionDigits
  }).format(Number(value || 0));
}

export function renderFxBlock(draft) {
  if (draft?.fx_required !== true) return [];

  const currency = String(draft?.currency || "").toUpperCase();
  const baseCurrency = String(draft?.base_currency || "").toUpperCase();
  const amountBaseCurrency = Number(draft?.amount_base_currency);
  const amountOriginal = Number(draft?.amount);
  const fxRate = Number(draft?.fx_rate);
  const fxProvider = String(draft?.fx_provider || "").trim();

  if (!currency || !baseCurrency || !Number.isFinite(amountBaseCurrency)) return [];

  const conversionPrefix = Number.isFinite(amountOriginal) && amountOriginal > 0
    ? `${formatMoney(amountOriginal)} ${currency} ≈ ${baseCurrency} ${formatMoney(amountBaseCurrency)}`
    : `≈ ${baseCurrency} ${formatMoney(amountBaseCurrency)}`;
  const lines = [conversionPrefix];
  const months = Number(draft?.msi_months);

  if (Number.isFinite(months) && months > 1) {
    lines.push(`(≈ ${baseCurrency} ${formatMoney(amountBaseCurrency / months)} / mes)`);
    return lines;
  }

  const meta = [];
  if (currency === "JPY" && baseCurrency === "MXN" && fxProvider === "fixed_trip") {
    meta.push("FX fijo: 1 MXN = 9 JPY");
  }
  if (Number.isFinite(fxRate) && fxRate > 0) {
    meta.push(`rate ${formatMoney(fxRate, { maximumFractionDigits: 6 })}`);
  }
  if (fxProvider) {
    meta.push(`provider ${fxProvider}`);
  }
  if (meta.length > 0) {
    lines.push(`(${meta.join(", ")})`);
  }

  return lines;
}

function tripShortId(tripId) {
  const value = String(tripId || "").trim();
  if (!value) return "";
  return value.slice(0, 8);
}

function formatTripLabel(draft) {
  const tripName = String(draft?.trip_name || "").trim();
  const tripId = String(draft?.trip_id || "").trim();
  const activeTripName = String(draft?.active_trip_name || "").trim();
  const hasActiveTrip = Boolean(String(draft?.active_trip_id || "").trim());

  if (hasActiveTrip && !tripId) {
    const label = activeTripName || "Viaje activo";
    return `${label} (excluido)`;
  }
  if (tripName && tripId) return `${tripName} (${tripShortId(tripId)}…)`;
  if (tripName) return tripName;
  if (tripId) return tripShortId(tripId);
  return "—";
}

export { APP_TZ, todayISOInTZ, minusDaysISOFromTZDate, overrideRelativeDate, cleanTextForDescription, guessMerchant };

export function guessCategory(text) {
  return coreGuessCategory(text, { allowedCategories: ALLOWED_CATEGORIES });
}

export function localParseExpense(text) {
  return coreLocalParseExpense(text, { allowedPaymentMethods: ALLOWED_PAYMENT_METHODS });
}

export function naiveParse(text) {
  return coreNaiveParse(text, { allowedPaymentMethods: ALLOWED_PAYMENT_METHODS });
}

export function validateDraft(d, { skipPaymentMethod = false } = {}) {
  return coreValidateDraft(d, {
    skipPaymentMethod,
    allowedPaymentMethods: ALLOWED_PAYMENT_METHODS,
    allowedCategories: ALLOWED_CATEGORIES
  });
}

export function paymentMethodPreview(d) {
  const lines = ["💳 <b>Elige método de pago</b>"];

  const isMsi = d?.is_msi === true;
  if (isMsi) {
    const total = Number(d.msi_total_amount || 0);
    const months = d.msi_months != null ? Number(d.msi_months) : null;
    const currency = d?.currency || "MXN";

    lines.push(`MSI: <b>sí</b>`);
    lines.push(`Total compra: <b>${escapeHtml(formatAmountWithCurrency(total, currency))}</b>`);
    if (!months || !Number.isFinite(months) || months <= 1) {
      lines.push(`Meses: <b>❓ (falta)</b>`);
    } else {
      lines.push(`Meses: <b>${escapeHtml(String(months))}</b>`);
    }
  } else {
    lines.push(`MSI: <b>no</b>`);
    lines.push(`Monto: <b>${escapeHtml(formatDraftAmount(d))}</b>`);
  }

  const fxLines = renderFxBlock(d);
  if (fxLines.length > 0) {
    lines.push("");
    lines.push(...fxLines.map((line) => escapeHtml(line)));
  }

  const paymentLabel = d.payment_method ? escapeHtml(d.payment_method) : "❓ (falta)";
  lines.push(`Método: <b>${paymentLabel}</b>`);
  lines.push(`Fecha: <b>${escapeHtml(d.purchase_date)}</b>`);
  lines.push("", "Toca un botón:");
  return lines.join("\n");
}

export function preview(d) {
  const lines = ["🧾 <b>Confirmar gasto</b>"];
  const isMsi = d?.is_msi === true;

  if (isMsi) {
    const total = Number(d.msi_total_amount || 0);
    const months = d.msi_months != null ? Number(d.msi_months) : null;
    const currency = d?.currency || "MXN";

    lines.push(`Tipo: <b>MSI</b>`);
    lines.push(`Total compra: <b>${escapeHtml(formatAmountWithCurrency(total, currency))}</b>`);

    if (!months || !Number.isFinite(months) || months <= 1) {
      lines.push(`Meses: <b>❓ (falta)</b>`);
      lines.push(`Mensualidad: <b>—</b>`);
    } else {
      const monthly = isFinite(d.amount_mxn) && d.amount_mxn > 0 ? Number(d.amount_mxn) : Math.round((total / months + Number.EPSILON) * 100) / 100;
      lines.push(`Meses: <b>${escapeHtml(String(months))}</b>`);
      lines.push(`Mensualidad aprox: <b>${escapeHtml(formatAmountWithCurrency(monthly, currency))}</b>`);
    }

    lines.push(d.msi_start_month ? `Mes de inicio: <b>${escapeHtml(d.msi_start_month)}</b>` : "Mes de inicio: <b>❓ (falta)</b>");
  } else {
    lines.push(`Monto: <b>${escapeHtml(formatDraftAmount(d))}</b>`);
  }

  const fxLines = renderFxBlock(d);
  if (fxLines.length > 0) {
    lines.push("");
    lines.push(...fxLines.map((line) => escapeHtml(line)));
  }

  const paymentLabel = d.payment_method ? escapeHtml(d.payment_method) : "❓ (falta)";
  lines.push(`Método: <b>${paymentLabel}</b>`);
  lines.push(`Fecha: <b>${escapeHtml(d.purchase_date)}</b>`);
  lines.push(`Viaje: <b>${escapeHtml(formatTripLabel(d))}</b>`);
  lines.push(`Categoría: <b>${escapeHtml(d.category)}</b>`);
  lines.push(`Descripción: ${escapeHtml(d.description)}`);
  if (d.merchant) lines.push(`Comercio: ${escapeHtml(d.merchant)}`);
  lines.push("", "Toca un botón:");
  return lines.join("\n");
}

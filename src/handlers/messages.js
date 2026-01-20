import { ALLOWED_PAYMENT_METHODS } from "../config.js";
import {
  tgSend,
  deleteConfirmKeyboard,
  paymentMethodKeyboard,
  escapeHtml,
  mainKeyboard
} from "../telegram.js";
import {
  localParseExpense,
  naiveParse,
  validateDraft,
  overrideRelativeDate,
  preview,
  guessCategory,
  guessMerchant,
  cleanTextForDescription,
  paymentMethodPreview
} from "../parsing.js";
import {
  getDraft,
  setDraft,
  clearDraft,
  clearAll,
  setPendingDelete,
  setLastExpenseId
} from "../state.js";
import {
  getExpenseById,
  countInstallmentsForExpense,
  getActiveCardNames,
  getBillingMonthForPurchase
} from "../storage/bigquery.js";
import { saveExpense } from "../usecases/save_expense.js";

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function looksLikeMsiText(text) {
  const t = String(text || "").toLowerCase();
  // cubre: "msi", "a msi", "6msi", "6 msi", "meses sin intereses"
  return (
    /\bmsi\b/.test(t) ||
    /\bmeses?\s+sin\s+intereses?\b/.test(t) ||
    /\d+\s*msi\b/.test(t)
  );
}

function parseJustMonths(text) {
  // Acepta "6", "6 meses", "a 6", "6 msi"
  const t = String(text || "").toLowerCase().trim();
  const m = t.match(/(\d{1,2})/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 1 || n > 60) return null;
  return n;
}

function isValidUuid(value) {
  const s = String(value || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s
  );
}

function normalizeBqDate(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object" && typeof value.value === "string") {
    return value.value;
  }
  return String(value);
}

function formatDeletePreview(expense, installmentsCount) {
  const lines = [
    "🗑️ <b>Confirmar borrado</b>",
    `ID: <code>${escapeHtml(expense.id)}</code>`,
    `Monto: <b>${escapeHtml(expense.amount_mxn)}</b>`,
    `Método: <b>${escapeHtml(expense.payment_method)}</b>`,
    `Fecha: <b>${escapeHtml(normalizeBqDate(expense.purchase_date))}</b>`,
    `Categoría: <b>${escapeHtml(expense.category || "Other")}</b>`,
    `Descripción: <b>${escapeHtml(expense.description || "")}</b>`
  ];

  if (expense.is_msi) {
    lines.push(
      `MSI: <b>sí</b>`,
      `Meses: <b>${escapeHtml(expense.msi_months)}</b>`,
      `Total MSI: <b>${escapeHtml(expense.msi_total_amount)}</b>`
    );
  } else {
    lines.push("MSI: <b>no</b>");
  }

  if (installmentsCount > 0) {
    lines.push(`⚠️ Esto eliminará también ${installmentsCount} mensualidades`);
  }

  return lines.join("\n");
}

function logBigQueryError(e) {
  console.error("❌ Error al guardar en BigQuery:", e?.name, e?.message);
  try {
    console.error("BigQuery e.errors:", JSON.stringify(e?.errors, null, 2));
  } catch (_) {
    // ignore
  }
}

export function createMessageHandler({
  sendMessage = tgSend,
  deleteConfirmKeyboardFn = deleteConfirmKeyboard,
  paymentMethodKeyboardFn = paymentMethodKeyboard,
  mainKeyboardFn = mainKeyboard,
  saveExpenseFn = saveExpense,
  getExpenseByIdFn = getExpenseById,
  countInstallmentsForExpenseFn = countInstallmentsForExpense,
  getActiveCardNamesFn = getActiveCardNames,
  getBillingMonthForPurchaseFn = getBillingMonthForPurchase
} = {}) {
  return async function handleMessage(msg) {
    if (!msg?.chat?.id) return;

    const chatId = String(msg.chat.id);
    const text = (msg.text || "").trim();

    if (!text) {
      await sendMessage(
        chatId,
        '✅ conectado. Mándame un gasto como: <b>230</b> Uber American Express ayer\n(Escribe <b>ayuda</b> para ejemplos)'
      );
      return;
    }

    const low = text.toLowerCase();

    if (low === "ayuda" || low === "/help") {
      await sendMessage(
        chatId,
        [
          "🧾 <b>Envíame un gasto</b>. Ej:",
          "<code>230 Uber American Express ayer</code>",
          "",
          "🧾 <b>MSI</b>. Ej:",
          "<code>gasolina 1200 BBVA Platino a MSI</code>",
          "y luego respondes sólo: <code>6</code>",
          "",
          "Luego confirma con botón ✅ o escribe <b>confirmar</b>.",
          "",
          "<b>Métodos válidos:</b>",
          ALLOWED_PAYMENT_METHODS.map((x) => `- ${escapeHtml(x)}`).join("\n"),
          "",
          "Nota: <b>'Amex'</b> a secas es ambiguo."
        ].join("\n")
      );
      return;
    }

    if (low === "cancelar" || low === "/cancel") {
      clearAll(chatId);
      await sendMessage(chatId, "🧹 <b>Cancelado</b>.");
      return;
    }

    if (low === "confirmar" || low === "/confirm") {
      const draft = getDraft(chatId);
      if (!draft) {
        await sendMessage(chatId, "No tengo borrador. Mándame un gasto primero.");
        return;
      }
      if (draft.is_msi && (!draft.msi_months || Number(draft.msi_months) <= 1)) {
        await sendMessage(
          chatId,
          "Faltan los meses MSI. Responde solo el número (ej: <code>6</code>)."
        );
        return;
      }
      if (!draft.payment_method) {
        await sendMessage(chatId, "Elige un método con botones o escribe cancelar.");
        return;
      }

      const result = await saveExpenseFn({ chatId, draft });
      if (result.ok) {
        setLastExpenseId(chatId, result.expenseId);
        clearDraft(chatId);
      }
      return;
    }

    const deleteMatch = text.match(/^(borrar|delete|rm)\s+(\S+)$/i);
    if (deleteMatch) {
      const expenseId = deleteMatch[2];
      if (!isValidUuid(expenseId)) {
        await sendMessage(
          chatId,
          "UUID inválido. Ejemplo: <code>borrar 123e4567-e89b-12d3-a456-426614174000</code>."
        );
        return;
      }

      try {
        const expense = await getExpenseByIdFn({ chatId, expenseId });
        if (!expense) {
          await sendMessage(chatId, "No encontré ese gasto para este chat.");
          return;
        }

        const installmentsCount = await countInstallmentsForExpenseFn({ chatId, expenseId });
        setPendingDelete(chatId, { expenseId, installmentsCount });

        await sendMessage(chatId, formatDeletePreview(expense, installmentsCount), {
          reply_markup: deleteConfirmKeyboardFn()
        });
      } catch (e) {
        logBigQueryError(e);
        await sendMessage(chatId, "❌ <b>No se pudo buscar el gasto</b>.");
      }
      return;
    }

    // =========================
    // FLUJO A: "Esperando meses" (MSI step 2)
    // =========================
    const existing = getDraft(chatId);
    if (existing?.__state === "awaiting_payment_method") {
      await sendMessage(chatId, "Elige un método con botones o escribe cancelar.");
      return;
    }

    if (existing?.__state === "awaiting_msi_months") {
      const n = parseJustMonths(text);
      if (!n) {
        await sendMessage(
          chatId,
          "Dime solo el número de meses (ej: <code>6</code>, <code>12</code>)."
        );
        return;
      }

      existing.is_msi = true;
      existing.msi_months = n;

      // total compra debe existir; si no, usa amount_mxn (por seguridad)
      if (!existing.msi_total_amount || Number(existing.msi_total_amount) <= 0) {
        existing.msi_total_amount = Number(existing.amount_mxn);
      }

      if (!existing.payment_method) {
        await sendMessage(chatId, "Elige un método con botones o escribe cancelar.");
        return;
      }

      existing.msi_start_month = await getBillingMonthForPurchaseFn({
        chatId,
        cardName: existing.payment_method,
        purchaseDateISO: existing.purchase_date
      });

      // amount_mxn = mensual (cashflow)
      existing.amount_mxn = round2(Number(existing.msi_total_amount) / n);

      existing.__state = "ready_to_confirm";
      setDraft(chatId, existing);
      await sendMessage(chatId, preview(existing), {
        reply_markup: mainKeyboardFn()
      });
      return;
    }

    // =========================
    // Detecta si es MSI (FLUJO B) o normal (FLUJO C)
    // =========================
    const localParseStart = Date.now();
    let draft = localParseExpense(text);
    const localParseMs = Date.now() - localParseStart;

    console.info(
      `⏱️ local-parse=${localParseMs}ms amounts=${draft.__meta?.amounts_found || 0} msi=${draft.is_msi}`
    );

    const wantsMsi = draft.is_msi || looksLikeMsiText(text);

    if (!/\d/.test(text)) {
      await sendMessage(
        chatId,
        '✅ conectado. Mándame un gasto como: <b>230</b> Uber American Express ayer\n(Escribe <b>ayuda</b> para ejemplos)'
      );
      return;
    }

    draft.raw_text = text;
    draft.purchase_date = overrideRelativeDate(text, draft.purchase_date);
    draft.__perf = { parse_ms: localParseMs };

    if (!isFinite(draft.amount_mxn) || draft.amount_mxn <= 0) {
      draft = naiveParse(text);
      draft.raw_text = text;
      draft.purchase_date = overrideRelativeDate(text, draft.purchase_date);
      draft.__perf = { parse_ms: localParseMs };
    }

    if (wantsMsi) {
      draft.is_msi = true;
      draft.msi_total_amount = Number(draft.msi_total_amount || draft.amount_mxn);
    }

    draft.payment_method = null;
    draft.amex_ambiguous = false;

    const amountToken = draft.__meta?.amount_tokens?.[0] || "";
    draft.description = cleanTextForDescription(text, amountToken, null) || "Gasto";
    draft.merchant = guessMerchant(text) || "";
    draft.category = guessCategory(`${draft.merchant} ${draft.description}`);

    const err = validateDraft(draft, { skipPaymentMethod: true });
    if (err) {
      await sendMessage(chatId, err);
      return;
    }

    // =========================
    // FLUJO B: MSI (step 1)
    // - parsea todo lo que se pueda del gasto,
    // - guarda draft incompleto,
    // - pregunta meses.
    // =========================
    if (wantsMsi) {
      // interpretamos el monto del texto como TOTAL de la compra
      draft.is_msi = true;
      draft.msi_total_amount = Number(draft.msi_total_amount || draft.amount_mxn);

      if (!Number.isFinite(draft.msi_months) || draft.msi_months <= 1) {
        draft.msi_months = null;
        draft.__state = "awaiting_payment_method";

        setDraft(chatId, draft);
        const activeCards = await getActiveCardNamesFn(chatId);
        const paymentMethods = activeCards?.length ? activeCards : ALLOWED_PAYMENT_METHODS;

        await sendMessage(chatId, paymentMethodPreview(draft), {
          reply_markup: paymentMethodKeyboardFn(paymentMethods)
        });
        return;
      }

      draft.amount_mxn = round2(Number(draft.msi_total_amount) / draft.msi_months);
      draft.__state = "awaiting_payment_method";

      setDraft(chatId, draft);
      const activeCards = await getActiveCardNamesFn(chatId);
      const paymentMethods = activeCards?.length ? activeCards : ALLOWED_PAYMENT_METHODS;

      await sendMessage(chatId, paymentMethodPreview(draft), {
        reply_markup: paymentMethodKeyboardFn(paymentMethods)
      });
      return;
    }

    // =========================
    // FLUJO C: normal (sin MSI)
    // =========================
    draft.is_msi = false;
    draft.msi_months = null;
    draft.msi_total_amount = null;
    draft.msi_start_month = null;

    draft.__state = "awaiting_payment_method";
    setDraft(chatId, draft);
    const activeCards = await getActiveCardNamesFn(chatId);
    const paymentMethods = activeCards?.length ? activeCards : ALLOWED_PAYMENT_METHODS;
    await sendMessage(chatId, paymentMethodPreview(draft), {
      reply_markup: paymentMethodKeyboardFn(paymentMethods)
    });
  };
}

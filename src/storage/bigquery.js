// storage/bigquery.js
import bigqueryPkg from "@google-cloud/bigquery";
const { BigQuery } = bigqueryPkg;
import crypto from "crypto";

import { BQ_PROJECT_ID, BQ_DATASET, BQ_TABLE } from "../config.js";

const bq = new BigQuery({ projectId: BQ_PROJECT_ID });

/* =======================
 * Helpers
 * ======================= */
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function money2(n) {
  // BigQuery NUMERIC: mejor como string con 2 decimales
  // IMPORTANTE: si n es null/undefined o NaN, truena para evitar guardar "0.00" por accidente
  const x = Number(n);
  if (!Number.isFinite(x)) {
    throw new Error(`money2(): invalid number: ${n}`);
  }
  return round2(x).toFixed(2);
}

function normalizeDateISO(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object" && typeof value.value === "string") {
    return value.value;
  }
  return String(value);
}

/* =======================
 * Insertar gasto SIMPLE (legacy / no MSI schedule)
 * ======================= */
export async function insertExpenseToBQ(draft, chatId) {
  const table = bq.dataset(BQ_DATASET).table(BQ_TABLE);

  const isMsi = draft.is_msi === true;

  const row = {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    purchase_date: draft.purchase_date,
    amount_mxn: money2(draft.amount_mxn),
    payment_method: draft.payment_method,
    category: draft.category || "Other",
    merchant: draft.merchant || null,
    description: draft.description || null,
    raw_text: draft.raw_text || null,
    source: "telegram",
    chat_id: String(chatId),

    is_msi: isMsi,
    msi_months: isMsi ? Number(draft.msi_months || null) : null,
    msi_start_month: isMsi ? (draft.msi_start_month || null) : null,
    msi_total_amount: isMsi
      ? money2(draft.msi_total_amount ?? draft.amount_mxn)
      : null
  };

  await table.insert([row], { skipInvalidRows: false, ignoreUnknownValues: false });
  return row.id;
}

/* =======================
 * Traer reglas activas de tarjetas
 * ======================= */
export async function getActiveCardRules() {
  const query = `
    SELECT
      chat_id,
      card_name,
      cut_day,
      pay_offset_days,
      roll_weekend_to_monday,
      billing_shift_months,
      active
    FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.card_rules\`
    WHERE active = TRUE
  `;

  const [job] = await bq.createQueryJob({ query });
  const [rows] = await job.getQueryResults();
  return rows;
}

/* =======================
 * Sumar gastos de un ciclo (NO MSI)
 * ======================= */
export async function sumExpensesForCycle({ chatId, cardName, startISO, endISO }) {
  const query = `
    SELECT
      COALESCE(SUM(amount_mxn), 0) AS total
    FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.${BQ_TABLE}\`
    WHERE chat_id = @chat_id
      AND payment_method = @card_name
      AND purchase_date BETWEEN DATE(@start_date) AND DATE(@end_date)
      AND (is_msi IS NULL OR is_msi = FALSE)
  `;

  const options = {
    query,
    params: {
      chat_id: String(chatId),
      card_name: String(cardName),
      start_date: startISO,
      end_date: endISO
    },
    parameterMode: "NAMED"
  };

  const [job] = await bq.createQueryJob(options);
  const [rows] = await job.getQueryResults();
  return Number(rows?.[0]?.total || 0);
}

/* =======================
 * Dedupe recordatorios
 * ======================= */
export async function alreadySentReminder({ chatId, cardName, cutISO }) {
  const query = `
    SELECT COUNT(1) AS c
    FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.reminder_log\`
    WHERE chat_id = @chat_id
      AND card_name = @card_name
      AND cut_date = DATE(@cut_date)
  `;

  const options = {
    query,
    params: {
      chat_id: String(chatId),
      card_name: String(cardName),
      cut_date: cutISO
    },
    parameterMode: "NAMED"
  };

  const [job] = await bq.createQueryJob(options);
  const [rows] = await job.getQueryResults();
  return Number(rows?.[0]?.c || 0) > 0;
}

export async function logReminderSent({ chatId, cardName, cutISO }) {
  const table = bq.dataset(BQ_DATASET).table("reminder_log");
  await table.insert([
    {
      chat_id: String(chatId),
      card_name: String(cardName),
      cut_date: cutISO,
      sent_at: new Date().toISOString()
    }
  ]);
}

/* =======================
 * Lista dinámica de tarjetas activas
 * ======================= */
export async function getActiveCardNames() {
  const query = `
    SELECT DISTINCT card_name
    FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.card_rules\`
    WHERE active = TRUE
    ORDER BY card_name
  `;

  const [job] = await bq.createQueryJob({ query });
  const [rows] = await job.getQueryResults();
  return rows.map((r) => String(r.card_name));
}

/* =======================
 * MSI: billing_month ("Sheet month B") para una compra
 * ======================= */
export async function getBillingMonthForPurchase({ chatId, cardName, purchaseDateISO }) {
  const query = `
  WITH r AS (
    SELECT
      cut_day,
      COALESCE(billing_shift_months, 0) AS billing_shift_months
    FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.card_rules\`
    WHERE chat_id = @chat_id
      AND card_name = @card_name
      AND active = TRUE
    LIMIT 1
  ),
  base AS (
    SELECT
      DATE_TRUNC(DATE(@purchase_date), MONTH) AS purchase_month,
      (SELECT cut_day FROM r) AS cut_day,
      (SELECT billing_shift_months FROM r) AS shift
  ),
  shifted AS (
    SELECT
      DATE_ADD(purchase_month, INTERVAL shift MONTH) AS monthB,
      cut_day
    FROM base
  )
  SELECT monthB AS billing_month
  FROM shifted
  `;

  const options = {
    query,
    params: {
      chat_id: String(chatId),
      card_name: String(cardName),
      purchase_date: purchaseDateISO
    },
    parameterMode: "NAMED"
  };

  const [job] = await bq.createQueryJob(options);
  const [rows] = await job.getQueryResults();
  const bm = rows?.[0]?.billing_month;
  if (!bm) throw new Error(`No billing_month found for ${cardName} ${purchaseDateISO}`);
  return normalizeDateISO(bm); // 'YYYY-MM-01'
}

/* =======================
 * MSI: helpers de installments
 * ======================= */
function splitIntoInstallments(total, n) {
  const cents = Math.round(Number(total) * 100);
  const base = Math.floor(cents / n);
  const rem = cents - base * n;

  const arr = Array(n).fill(base);
  arr[n - 1] = base + rem; // ajusta centavos al final
  return arr.map((c) => c / 100);
}

function addMonthsYYYYMM01(yyyyMm01, k) {
  const d = new Date(`${yyyyMm01}T12:00:00Z`);
  const y = d.getUTCFullYear();
  const m0 = d.getUTCMonth();
  const nd = new Date(Date.UTC(y, m0 + k, 1, 12, 0, 0));
  return nd.toISOString().slice(0, 10);
}

async function installmentsExistForExpense(expenseId) {
  const query = `
    SELECT COUNT(1) AS c
    FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.installments\`
    WHERE expense_id = @expense_id
  `;
  const options = {
    query,
    params: { expense_id: String(expenseId) },
    parameterMode: "NAMED"
  };
  const [job] = await bq.createQueryJob(options);
  const [rows] = await job.getQueryResults();
  return Number(rows?.[0]?.c || 0) > 0;
}

export async function createInstallmentsForExpense({
  expenseId,
  chatId,
  cardName,
  billingMonthISO,
  monthsTotal,
  totalAmount
}) {
  // ✅ dedupe simple
  if (await installmentsExistForExpense(expenseId)) return 0;

  const table = bq.dataset(BQ_DATASET).table("installments");
  const amounts = splitIntoInstallments(totalAmount, monthsTotal);
  const nowISO = new Date().toISOString();

  const rows = amounts.map((amt, i) => ({
    installment_id: crypto.randomUUID(),
    expense_id: String(expenseId),
    chat_id: String(chatId),
    card_name: String(cardName),
    billing_month: normalizeDateISO(addMonthsYYYYMM01(billingMonthISO, i)), // YYYY-MM-01
    installment_number: i + 1,
    months_total: Number(monthsTotal),
    amount_mxn: money2(amt), // ✅ NUMERIC como string
    status: "SCHEDULED",
    created_at: nowISO
  }));

  await table.insert(rows, { skipInvalidRows: false, ignoreUnknownValues: false });
  return rows.length;
}

/* =======================
 * ✅ FUNCIÓN PRINCIPAL:
 * Inserta expense y si es MSI genera installments
 * ======================= */
export async function insertExpenseAndMaybeInstallments(draft, chatId) {
  const table = bq.dataset(BQ_DATASET).table(BQ_TABLE);

  const expenseId = crypto.randomUUID();
  const isMsi = draft.is_msi === true;

  let billingMonthISO = null;
  let msiMonths = null;
  let msiTotal = null;
  let monthlyAmount = null;

  if (isMsi) {
    msiMonths = Number(draft.msi_months);
    if (!Number.isFinite(msiMonths) || msiMonths <= 1) {
      throw new Error("MSI inválido: msi_months debe ser >= 2");
    }

    // ✅ total real de la compra (no mensual)
    msiTotal = Number(draft.msi_total_amount);
    if (!Number.isFinite(msiTotal) || msiTotal <= 0) {
      throw new Error("MSI inválido: msi_total_amount debe ser > 0");
    }

    // ✅ cashflow mensual (aunque deepseek se equivoque)
    monthlyAmount = round2(msiTotal / msiMonths);

    // ✅ mes B según card_rules
    billingMonthISO = await getBillingMonthForPurchase({
      chatId,
      cardName: draft.payment_method,
      purchaseDateISO: draft.purchase_date
    });
  }

  const row = {
    id: String(expenseId),
    created_at: new Date().toISOString(),
    purchase_date: normalizeDateISO(draft.purchase_date),
    amount_mxn: isMsi ? money2(monthlyAmount) : money2(draft.amount_mxn),
    payment_method: draft.payment_method,
    category: draft.category || "Other",
    merchant: draft.merchant || null,
    description: draft.description || null,
    raw_text: draft.raw_text || null,
    source: "telegram",
    chat_id: String(chatId),

    is_msi: isMsi,
    msi_months: isMsi ? msiMonths : null,
    msi_start_month: isMsi ? normalizeDateISO(billingMonthISO) : null, // primer billing month (mes B)
    msi_total_amount: isMsi ? money2(msiTotal) : null
  };

  await table.insert([row], { skipInvalidRows: false, ignoreUnknownValues: false });

  if (isMsi) {
    await createInstallmentsForExpense({
      expenseId,
      chatId,
      cardName: draft.payment_method,
      billingMonthISO,
      monthsTotal: msiMonths,
      totalAmount: msiTotal
    });
  }

  return expenseId;
}

/* =======================
 * Borrar gasto por ID (con cascade a MSI)
 * ======================= */
export async function getExpenseById({ chatId, expenseId }) {
  const query = `
    SELECT
      id,
      purchase_date,
      amount_mxn,
      payment_method,
      category,
      description,
      is_msi,
      msi_months,
      msi_total_amount
    FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.${BQ_TABLE}\`
    WHERE chat_id = @chat_id
      AND id = @expense_id
    LIMIT 1
  `;

  const options = {
    query,
    params: {
      chat_id: String(chatId),
      expense_id: String(expenseId)
    },
    parameterMode: "NAMED"
  };

  const [job] = await bq.createQueryJob(options);
  const [rows] = await job.getQueryResults();
  return rows?.[0] || null;
}

export async function countInstallmentsForExpense({ chatId, expenseId }) {
  const query = `
    SELECT COUNT(1) AS c
    FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.installments\`
    WHERE chat_id = @chat_id
      AND expense_id = @expense_id
  `;

  const options = {
    query,
    params: {
      chat_id: String(chatId),
      expense_id: String(expenseId)
    },
    parameterMode: "NAMED"
  };

  const [job] = await bq.createQueryJob(options);
  const [rows] = await job.getQueryResults();
  return Number(rows?.[0]?.c || 0);
}

export async function deleteExpenseCascade({ chatId, expenseId }) {
  const query = `
    DECLARE deleted_installments INT64 DEFAULT 0;
    DECLARE deleted_expense INT64 DEFAULT 0;
    BEGIN
      DELETE FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.installments\`
      WHERE chat_id = @chat_id
        AND expense_id = @expense_id;
      SET deleted_installments = @@row_count;

      DELETE FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.${BQ_TABLE}\`
      WHERE chat_id = @chat_id
        AND id = @expense_id;
      SET deleted_expense = @@row_count;
    END;
    SELECT
      deleted_installments AS deleted_installments,
      deleted_expense AS deleted_expense
  `;

  const options = {
    query,
    params: {
      chat_id: String(chatId),
      expense_id: String(expenseId)
    },
    parameterMode: "NAMED"
  };

  const [job] = await bq.createQueryJob(options);
  const [rows] = await job.getQueryResults();
  return {
    deletedInstallments: Number(rows?.[0]?.deleted_installments || 0),
    deletedExpense: Number(rows?.[0]?.deleted_expense || 0)
  };
}

import bigqueryPkg from "@google-cloud/bigquery";
const { BigQuery } = bigqueryPkg;
import crypto from "crypto";

import { BQ_PROJECT_ID, BQ_DATASET, BQ_TABLE } from "../config.js";

const bq = new BigQuery({ projectId: BQ_PROJECT_ID });

/* =======================
 * Insertar gasto SIMPLE (legacy / no MSI schedule)
 * - Déjalo por compatibilidad si quieres.
 * - Para MSI usa insertExpenseAndMaybeInstallments()
 * ======================= */
export async function insertExpenseToBQ(draft, chatId) {
  const table = bq.dataset(BQ_DATASET).table(BQ_TABLE);

  const row = {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    purchase_date: draft.purchase_date,
    amount_mxn: Number(draft.amount_mxn),
    payment_method: draft.payment_method,
    category: draft.category || "Other",
    merchant: draft.merchant || null,
    description: draft.description || null,
    raw_text: draft.raw_text || null,
    source: "telegram",
    chat_id: String(chatId),

    // MSI (si vienen, los guarda; pero no genera installments)
    is_msi: draft.is_msi === true,
    msi_months: draft.is_msi ? Number(draft.msi_months || null) : null,
    msi_start_month: draft.is_msi ? (draft.msi_start_month || null) : null,
    msi_total_amount: draft.is_msi ? Number(draft.msi_total_amount || draft.amount_mxn) : null
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
 * Sumar gastos de un ciclo (NO MSI, como antes)
 * ======================= */
export async function sumExpensesForCycle({ chatId, cardName, startISO, endISO }) {
  const query = `
    SELECT
      COALESCE(SUM(amount_mxn), 0) AS total
    FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.${BQ_TABLE}\`
    WHERE chat_id = @chat_id
      AND payment_method = @card_name
      AND purchase_date BETWEEN DATE(@start_date) AND DATE(@end_date)
      -- MSI ignorados por ahora (heurística simple)
      AND (raw_text IS NULL OR LOWER(raw_text) NOT LIKE '%msi%')
      AND (description IS NULL OR LOWER(description) NOT LIKE '%msi%')
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
 * Opcional: lista dinámica de tarjetas activas
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
 * MSI: calcular billing_month ("Sheet month B") para una compra
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
  return String(bm); // 'YYYY-MM-01'
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

export async function createInstallmentsForExpense({
  expenseId,
  chatId,
  cardName,
  billingMonthISO,
  monthsTotal,
  totalAmount
}) {
  const table = bq.dataset(BQ_DATASET).table("installments");
  const amounts = splitIntoInstallments(totalAmount, monthsTotal);
  const nowISO = new Date().toISOString();

  const rows = amounts.map((amt, i) => ({
    installment_id: crypto.randomUUID(),
    expense_id: String(expenseId),
    chat_id: String(chatId),
    card_name: String(cardName),
    billing_month: addMonthsYYYYMM01(billingMonthISO, i), // YYYY-MM-01
    installment_number: i + 1,
    months_total: Number(monthsTotal),
    amount_mxn: Number(amt),
    status: "SCHEDULED",
    created_at: nowISO
  }));

  await table.insert(rows, { skipInvalidRows: false, ignoreUnknownValues: false });
  return rows.length;
}

/* =======================
 * ✅ FUNCIÓN PRINCIPAL NUEVA:
 * Inserta expense y si es MSI genera installments
 * ======================= */
export async function insertExpenseAndMaybeInstallments(draft, chatId) {
  const table = bq.dataset(BQ_DATASET).table(BQ_TABLE);

  const expenseId = crypto.randomUUID();
  const isMsi = draft.is_msi === true;

  let billingMonthISO = null;
  let msiMonths = null;
  let msiTotal = null;

  if (isMsi) {
    msiMonths = Number(draft.msi_months);
    if (!Number.isFinite(msiMonths) || msiMonths <= 1) {
      throw new Error("MSI inválido: msi_months debe ser >= 2");
    }

    msiTotal = Number(draft.msi_total_amount || draft.amount_mxn);
    if (!Number.isFinite(msiTotal) || msiTotal <= 0) {
      throw new Error("MSI inválido: total amount debe ser > 0");
    }

    billingMonthISO = await getBillingMonthForPurchase({
      chatId,
      cardName: draft.payment_method,
      purchaseDateISO: draft.purchase_date
    });
  }

  const row = {
    id: expenseId,
    created_at: new Date().toISOString(),
    purchase_date: draft.purchase_date,
    amount_mxn: Number(draft.amount_mxn),
    payment_method: draft.payment_method,
    category: draft.category || "Other",
    merchant: draft.merchant || null,
    description: draft.description || null,
    raw_text: draft.raw_text || null,
    source: "telegram",
    chat_id: String(chatId),

    // MSI fields
    is_msi: isMsi,
    msi_months: isMsi ? msiMonths : null,
    msi_start_month: isMsi ? billingMonthISO : null,
    msi_total_amount: isMsi ? msiTotal : null
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

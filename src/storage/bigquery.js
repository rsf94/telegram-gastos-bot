import bigqueryPkg from "@google-cloud/bigquery";
const { BigQuery } = bigqueryPkg;
import crypto from "crypto";

import { BQ_PROJECT_ID, BQ_DATASET, BQ_TABLE } from "../config.js";

const bq = new BigQuery({ projectId: BQ_PROJECT_ID });

/* =======================
 * Insertar gasto (ya lo tenías)
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
    chat_id: String(chatId)
  };

  await table.insert([row], {
    skipInvalidRows: false,
    ignoreUnknownValues: false
  });

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
      active
    FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.card_rules\`
    WHERE active = TRUE
  `;

  const [job] = await bq.createQueryJob({ query });
  const [rows] = await job.getQueryResults();
  return rows;
}

/* =======================
 * Sumar gastos de un ciclo
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
 * Dedupe: ¿ya mandé recordatorio de este corte?
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
      cut_date: cutISO, // DATE (string YYYY-MM-DD ok)
      sent_at: new Date().toISOString()
    }
  ]);
}

// storage/bigquery.js
import bigqueryPkg from "@google-cloud/bigquery";
const { BigQuery } = bigqueryPkg;
import crypto from "crypto";

import {
  BQ_PROJECT_ID,
  BQ_DATASET,
  BQ_TABLE,
  BQ_ENRICHMENT_RETRY_TABLE
} from "../config.js";

export const ACTIVE_TRIP_NONE_SENTINEL = "__NONE__";
import {
  getCardRuleWithMeta,
  getActiveCardNames as getActiveCardNamesCached
} from "../cache/card_rules_cache.js";

const bq = new BigQuery({ projectId: BQ_PROJECT_ID });
let userLinksTableOverride = null;

function getUserLinksTable() {
  if (userLinksTableOverride) return userLinksTableOverride;
  return bq.dataset(BQ_DATASET).table("user_links");
}

function tokenPreview(token) {
  const value = String(token || "");
  return {
    prefix: value.slice(0, 6),
    length: value.length
  };
}

function sanitizeForLogs(input, { linkToken }) {
  if (typeof input === "string") {
    if (!linkToken) return input;
    return input.split(linkToken).join("[REDACTED_LINK_TOKEN]");
  }
  if (Array.isArray(input)) {
    return input.map((value) => sanitizeForLogs(value, { linkToken }));
  }
  if (input && typeof input === "object") {
    const out = {};
    for (const [key, value] of Object.entries(input)) {
      out[key] = sanitizeForLogs(value, { linkToken });
    }
    return out;
  }
  return input;
}

function buildInsertErrorDetails(err, linkToken) {
  const errors = [];
  if (Array.isArray(err?.errors)) {
    errors.push(...err.errors);
  }
  if (Array.isArray(err?.response?.insertErrors)) {
    errors.push(...err.response.insertErrors);
  }
  return sanitizeForLogs(errors, { linkToken });
}

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

function dateAtNoonUTC(iso) {
  return new Date(`${iso}T12:00:00Z`);
}

function lastDayOfMonth(year, month1to12) {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

function clampDay(year, month1to12, day) {
  return Math.min(day, lastDayOfMonth(year, month1to12));
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
    user_id: draft.user_id ? String(draft.user_id) : null,

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

export async function resolveUserIdByChatId(chatId, { bigqueryClient } = {}) {
  const client = bigqueryClient || bq;
  const query = `
    SELECT user_id
    FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.chat_links\`
    WHERE chat_id = @chat_id
      AND status = 'LINKED'
    ORDER BY created_at DESC
    LIMIT 1
  `;

  const options = {
    query,
    location: "US",
    params: {
      chat_id: String(chatId)
    }
  };

  const [rows] = await client.query(options);
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  const userId = rows[0]?.user_id;
  return userId ? String(userId) : null;
}

export async function insertPendingUserLink({
  linkToken,
  chatId,
  expiresAt,
  createdAt = new Date(),
  requestId = null
}) {
  const table = getUserLinksTable();
  const chatIdString = String(chatId);
  const row = {
    link_token: String(linkToken),
    chat_id: chatIdString,
    status: "PENDING",
    created_at: new Date(createdAt).toISOString(),
    expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
    email: null,
    provider: "telegram",
    linked_at: null,
    last_seen_at: null,
    metadata: JSON.stringify({ telegram_chat_id: chatIdString })
  };

  try {
    await table.insert([row]);
  } catch (err) {
    const payload = {
      type: "bq_insert_error",
      table: "gastos.user_links",
      flow: "dashboard_link",
      request_id: requestId,
      chat_id: chatIdString,
      link_token_preview: tokenPreview(linkToken),
      errors: buildInsertErrorDetails(err, String(linkToken))
    };
    console.error(JSON.stringify(payload));
    throw err;
  }
}

export function __setUserLinksTableForTests(table) {
  userLinksTableOverride = table;
}

function toMetadataValue(metadata) {
  if (metadata === undefined || metadata === null) return null;
  if (typeof metadata === "string") return metadata;
  return JSON.stringify(metadata);
}

export async function createTrip({
  chat_id,
  name,
  base_currency = null,
  start_date = null,
  end_date = null,
  active = null,
  metadata = null
}, { tableClient } = {}) {
  const table = tableClient || bq.dataset(BQ_DATASET).table("trips");
  const nowISO = new Date().toISOString();
  const row = {
    trip_id: crypto.randomUUID(),
    chat_id: String(chat_id),
    name: String(name),
    base_currency: base_currency ? String(base_currency) : null,
    start_date: start_date || null,
    end_date: end_date || null,
    active: typeof active === "boolean" ? active : null,
    created_at: nowISO,
    updated_at: null,
    metadata: toMetadataValue(metadata)
  };

  await table.insert([row], { skipInvalidRows: false, ignoreUnknownValues: false });
  return row;
}

export async function setActiveTrip({ chat_id, trip_id, metadata = null }, { tableClient } = {}) {
  const table = tableClient || bq.dataset(BQ_DATASET).table("trip_state");
  const activeTripId =
    trip_id === null || trip_id === undefined || trip_id === ""
      ? ACTIVE_TRIP_NONE_SENTINEL
      : String(trip_id);
  const row = {
    chat_id: String(chat_id),
    active_trip_id: activeTripId,
    set_at: new Date().toISOString(),
    updated_at: null,
    metadata: toMetadataValue(metadata)
  };

  await table.insert([row], { skipInvalidRows: false, ignoreUnknownValues: false });
  return row;
}

export async function getActiveTripId(chatId, { bigqueryClient } = {}) {
  const query = `
    SELECT active_trip_id
    FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.trip_state\`
    WHERE chat_id = @chat_id
    ORDER BY set_at DESC
    LIMIT 1
  `;

  const options = {
    query,
    params: {
      chat_id: String(chatId)
    },
    parameterMode: "NAMED"
  };

  const client = bigqueryClient || bq;
  const [job] = await client.createQueryJob(options);
  const [rows] = await job.getQueryResults();
  const activeTripId = rows?.[0]?.active_trip_id || null;
  if (!activeTripId || activeTripId === ACTIVE_TRIP_NONE_SENTINEL) return null;
  return activeTripId;
}

export async function listTrips(chatId, limit = 10, { bigqueryClient } = {}) {
  const query = `
    SELECT
      trip_id,
      chat_id,
      name,
      base_currency,
      start_date,
      end_date,
      active,
      created_at,
      updated_at,
      metadata
    FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.trips\`
    WHERE chat_id = @chat_id
    ORDER BY created_at DESC
    LIMIT @limit
  `;

  const options = {
    query,
    params: {
      chat_id: String(chatId),
      limit: Number(limit)
    },
    parameterMode: "NAMED"
  };

  const client = bigqueryClient || bq;
  const [job] = await client.createQueryJob(options);
  const [rows] = await job.getQueryResults();
  return rows || [];
}

export async function getTripById(chatId, tripId, { bigqueryClient } = {}) {
  const query = `
    SELECT
      trip_id,
      chat_id,
      name,
      base_currency,
      start_date,
      end_date,
      active,
      created_at,
      updated_at,
      metadata
    FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.trips\`
    WHERE chat_id = @chat_id AND trip_id = @trip_id
    LIMIT 1
  `;

  const options = {
    query,
    params: {
      chat_id: String(chatId),
      trip_id: String(tripId)
    },
    parameterMode: "NAMED"
  };

  const client = bigqueryClient || bq;
  const [job] = await client.createQueryJob(options);
  const [rows] = await job.getQueryResults();
  return rows?.[0] || null;
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
export async function getActiveCardNames(chatId) {
  return getActiveCardNamesCached(chatId);
}

/* =======================
 * Analysis helpers
 * ======================= */
export async function getAnalysisCategoryTotals({ chatId, monthISO }) {
  const query = `
    WITH params AS (
      SELECT
        DATE_TRUNC(DATE(@month), MONTH) AS month_start,
        DATE_ADD(DATE_TRUNC(DATE(@month), MONTH), INTERVAL 1 MONTH) AS next_month
    ),
    no_msi AS (
      SELECT
        COALESCE(category, 'Other') AS category,
        SUM(amount_mxn) AS total
      FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.${BQ_TABLE}\`, params
      WHERE chat_id = @chat_id
        AND purchase_date >= params.month_start
        AND purchase_date < params.next_month
        AND (is_msi IS NULL OR is_msi = FALSE)
      GROUP BY category
    ),
    msi AS (
      SELECT
        COALESCE(e.category, 'Other') AS category,
        SUM(i.amount_mxn) AS total
      FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.installments\` i
      JOIN \`${BQ_PROJECT_ID}.${BQ_DATASET}.${BQ_TABLE}\` e
        ON e.id = i.expense_id AND e.chat_id = i.chat_id
      CROSS JOIN params
      WHERE i.chat_id = @chat_id
        AND i.billing_month = params.month_start
        AND i.status != 'PAID'
      GROUP BY category
    ),
    combined AS (
      SELECT category, total FROM no_msi
      UNION ALL
      SELECT category, total FROM msi
    )
    SELECT category, SUM(total) AS total
    FROM combined
    GROUP BY category
    ORDER BY total DESC
    LIMIT 50
  `;

  const options = {
    query,
    params: {
      chat_id: String(chatId),
      month: monthISO
    },
    parameterMode: "NAMED"
  };

  const [job] = await bq.createQueryJob(options);
  const [rows] = await job.getQueryResults();
  return rows || [];
}

export async function getAnalysisNoMsiTotalsByCardRanges({ chatId, ranges }) {
  if (!ranges?.length) return [];

  const query = `
    WITH cards AS (
      SELECT * FROM UNNEST(@cards) AS card
    )
    SELECT
      card.card_name AS card_name,
      COALESCE(SUM(e.amount_mxn), 0) AS total
    FROM cards card
    LEFT JOIN \`${BQ_PROJECT_ID}.${BQ_DATASET}.${BQ_TABLE}\` e
      ON e.chat_id = @chat_id
      AND e.payment_method = card.card_name
      AND e.purchase_date BETWEEN DATE(card.start_date) AND DATE(card.end_date)
      AND (e.is_msi IS NULL OR e.is_msi = FALSE)
    GROUP BY card.card_name
    ORDER BY card.card_name
  `;

  const options = {
    query,
    params: {
      chat_id: String(chatId),
      cards: ranges.map((r) => ({
        card_name: String(r.card_name),
        start_date: String(r.start_date),
        end_date: String(r.end_date)
      }))
    },
    parameterMode: "NAMED"
  };

  const [job] = await bq.createQueryJob(options);
  const [rows] = await job.getQueryResults();
  return rows || [];
}

export async function getAnalysisMsiTotalsByCard({ chatId, cardNames, monthISO }) {
  if (!cardNames?.length) return [];

  const query = `
    SELECT
      card_name,
      COALESCE(SUM(amount_mxn), 0) AS total
    FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.installments\`
    WHERE chat_id = @chat_id
      AND billing_month = DATE_TRUNC(DATE(@month), MONTH)
      AND status != 'PAID'
      AND card_name IN UNNEST(@card_names)
    GROUP BY card_name
    ORDER BY card_name
  `;

  const options = {
    query,
    params: {
      chat_id: String(chatId),
      month: monthISO,
      card_names: cardNames.map((name) => String(name))
    },
    parameterMode: "NAMED"
  };

  const [job] = await bq.createQueryJob(options);
  const [rows] = await job.getQueryResults();
  return rows || [];
}

export async function getCardCashflowTotal({ chatId, cardName, monthISO }) {
  const query = `
    WITH params AS (
      SELECT
        DATE_TRUNC(DATE(@month), MONTH) AS month_start,
        DATE_ADD(DATE_TRUNC(DATE(@month), MONTH), INTERVAL 1 MONTH) AS next_month
    ),
    no_msi AS (
      SELECT COALESCE(SUM(amount_mxn), 0) AS total
      FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.${BQ_TABLE}\`, params
      WHERE chat_id = @chat_id
        AND payment_method = @card_name
        AND purchase_date >= params.month_start
        AND purchase_date < params.next_month
        AND (is_msi IS NULL OR is_msi = FALSE)
    ),
    msi AS (
      SELECT COALESCE(SUM(i.amount_mxn), 0) AS total
      FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.installments\` i
      CROSS JOIN params
      WHERE i.chat_id = @chat_id
        AND i.card_name = @card_name
        AND i.billing_month = params.month_start
        AND i.status != 'PAID'
    )
    SELECT (no_msi.total + msi.total) AS total
    FROM no_msi CROSS JOIN msi
  `;

  const options = {
    query,
    params: {
      chat_id: String(chatId),
      card_name: String(cardName),
      month: monthISO
    },
    parameterMode: "NAMED"
  };

  const [job] = await bq.createQueryJob(options);
  const [rows] = await job.getQueryResults();
  return Number(rows?.[0]?.total || 0);
}

export async function getAnalysisPendingMsiTotal({ chatId }) {
  const query = `
    SELECT COALESCE(SUM(amount_mxn), 0) AS total
    FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.installments\`
    WHERE chat_id = @chat_id
      AND status != 'PAID'
      AND billing_month IS NOT NULL
  `;

  const options = {
    query,
    params: { chat_id: String(chatId) },
    parameterMode: "NAMED"
  };

  const [job] = await bq.createQueryJob(options);
  const [rows] = await job.getQueryResults();
  return Number(rows?.[0]?.total || 0);
}

export async function getAnalysisPendingMsiByCard({ chatId, limit = 6 }) {
  const query = `
    SELECT
      card_name,
      SUM(amount_mxn) AS total
    FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.installments\`
    WHERE chat_id = @chat_id
      AND status != 'PAID'
      AND billing_month IS NOT NULL
    GROUP BY card_name
    ORDER BY total DESC
    LIMIT @limit
  `;

  const options = {
    query,
    params: {
      chat_id: String(chatId),
      limit: Number(limit)
    },
    parameterMode: "NAMED"
  };

  const [job] = await bq.createQueryJob(options);
  const [rows] = await job.getQueryResults();
  return rows || [];
}

export async function getAnalysisPendingMsiByMonth({ chatId, startMonthISO, limit = 6 }) {
  const query = `
    SELECT
      billing_month,
      SUM(amount_mxn) AS total
    FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.installments\`
    WHERE chat_id = @chat_id
      AND status != 'PAID'
      AND billing_month IS NOT NULL
      AND billing_month >= DATE(@start_month)
    GROUP BY billing_month
    ORDER BY billing_month
    LIMIT @limit
  `;

  const options = {
    query,
    params: {
      chat_id: String(chatId),
      start_month: startMonthISO,
      limit: Number(limit)
    },
    parameterMode: "NAMED"
  };

  const [job] = await bq.createQueryJob(options);
  const [rows] = await job.getQueryResults();
  return rows || [];
}

export async function getAnalysisCategoryDelta({ chatId, monthISO }) {
  const query = `
    WITH params AS (
      SELECT
        DATE_TRUNC(DATE(@month), MONTH) AS current_month,
        DATE_SUB(DATE_TRUNC(DATE(@month), MONTH), INTERVAL 1 MONTH) AS prev_month
    ),
    no_msi AS (
      SELECT
        DATE_TRUNC(purchase_date, MONTH) AS month,
        COALESCE(category, 'Other') AS category,
        SUM(amount_mxn) AS total
      FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.${BQ_TABLE}\`, params
      WHERE chat_id = @chat_id
        AND purchase_date >= params.prev_month
        AND purchase_date < DATE_ADD(params.current_month, INTERVAL 1 MONTH)
        AND (is_msi IS NULL OR is_msi = FALSE)
      GROUP BY month, category
    ),
    msi AS (
      SELECT
        i.billing_month AS month,
        COALESCE(e.category, 'Other') AS category,
        SUM(i.amount_mxn) AS total
      FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.installments\` i
      JOIN \`${BQ_PROJECT_ID}.${BQ_DATASET}.${BQ_TABLE}\` e
        ON e.id = i.expense_id AND e.chat_id = i.chat_id
      CROSS JOIN params
      WHERE i.chat_id = @chat_id
        AND i.status != 'PAID'
        AND i.billing_month IN (params.prev_month, params.current_month)
      GROUP BY month, category
    ),
    combined AS (
      SELECT month, category, total FROM no_msi
      UNION ALL
      SELECT month, category, total FROM msi
    ),
    agg AS (
      SELECT month, category, SUM(total) AS total
      FROM combined
      GROUP BY month, category
    )
    SELECT
      category,
      SUM(IF(month = params.current_month, total, 0)) AS current_total,
      SUM(IF(month = params.prev_month, total, 0)) AS prev_total
    FROM agg
    CROSS JOIN params
    GROUP BY category, params.current_month, params.prev_month
  `;

  const options = {
    query,
    params: {
      chat_id: String(chatId),
      month: monthISO
    },
    parameterMode: "NAMED"
  };

  const [job] = await bq.createQueryJob(options);
  const [rows] = await job.getQueryResults();
  return rows || [];
}

export async function updateExpenseEnrichment({
  chatId,
  expenseId,
  category,
  merchant,
  description
}) {
  const query = `
    UPDATE \`${BQ_PROJECT_ID}.${BQ_DATASET}.${BQ_TABLE}\`
    SET
      category = @category,
      merchant = @merchant,
      description = @description
    WHERE chat_id = @chat_id
      AND id = @expense_id
  `;

  const options = {
    query,
    params: {
      chat_id: String(chatId),
      expense_id: String(expenseId),
      category: String(category || "Other"),
      merchant: merchant ? String(merchant) : null,
      description: description ? String(description) : null
    },
    parameterMode: "NAMED"
  };

  const [job] = await bq.createQueryJob(options);
  await job.getQueryResults();
  const [metadata] = await job.getMetadata();
  const affected = Number(metadata?.statistics?.query?.numDmlAffectedRows || 0);
  if (!affected) {
    const err = new Error("BQ_UPDATE_NO_ROWS");
    err.code = "BQ_UPDATE_NO_ROWS";
    throw err;
  }

  return affected;
}

/* =======================
 * Enrichment retry queue
 * ======================= */
export async function enqueueEnrichmentRetry({
  expenseId,
  chatId,
  category,
  merchant,
  description,
  attempts = 0,
  nextAttemptAt,
  lastError,
  status = "PENDING",
  runId
}) {
  return insertEnrichmentRetryEvent({
    expenseId,
    chatId,
    category,
    merchant,
    description,
    attempts,
    nextAttemptAt,
    lastError,
    status,
    runId
  });
}

function isMissingColumnError(error, column) {
  const msg = String(error?.message || error || "").toLowerCase();
  return msg.includes(`no such field: ${column}`) || msg.includes(`name ${column} not found`);
}

export function buildLatestEnrichmentRetryQuery({ limit }) {
  return `
    WITH latest AS (
      SELECT
        expense_id,
        chat_id,
        category,
        merchant,
        description,
        attempts,
        next_attempt_at,
        last_error,
        status,
        created_at
      FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.${BQ_ENRICHMENT_RETRY_TABLE}\`
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY expense_id
        ORDER BY created_at DESC
      ) = 1
    )
    SELECT
      expense_id,
      chat_id,
      category,
      merchant,
      description,
      attempts,
      next_attempt_at,
      last_error,
      status,
      created_at
    FROM latest
    WHERE COALESCE(next_attempt_at, TIMESTAMP("1970-01-01")) <= TIMESTAMP(@now)
      AND (status IS NULL OR status != "SUCCEEDED")
    ORDER BY next_attempt_at ASC
    LIMIT ${limit}
  `;
}

export function buildLegacyEnrichmentRetryQuery({ limit }) {
  return `
    SELECT
      expense_id,
      chat_id,
      category,
      merchant,
      description,
      attempts,
      next_attempt_at,
      last_error,
      status
    FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.${BQ_ENRICHMENT_RETRY_TABLE}\`
    WHERE COALESCE(TIMESTAMP(next_attempt_at), TIMESTAMP("1970-01-01")) <= TIMESTAMP(@now)
      AND (status IS NULL OR status != "SUCCEEDED")
    ORDER BY next_attempt_at ASC
    LIMIT ${limit}
  `;
}

export function buildEnrichmentRetryStatsQuery() {
  return `
    WITH latest AS (
      SELECT
        expense_id,
        next_attempt_at,
        status,
        created_at
      FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.${BQ_ENRICHMENT_RETRY_TABLE}\`
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY expense_id
        ORDER BY created_at DESC
      ) = 1
    )
    SELECT
      COUNTIF(COALESCE(next_attempt_at, TIMESTAMP("1970-01-01")) > TIMESTAMP(@now)) AS not_due,
      COUNT(1) AS total_pending
    FROM latest
    WHERE (status IS NULL OR status != "SUCCEEDED")
  `;
}

export function buildLegacyEnrichmentRetryStatsQuery() {
  return `
    SELECT
      COUNTIF(COALESCE(TIMESTAMP(next_attempt_at), TIMESTAMP("1970-01-01")) > TIMESTAMP(@now)) AS not_due,
      COUNT(1) AS total_pending
    FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.${BQ_ENRICHMENT_RETRY_TABLE}\`
    WHERE (status IS NULL OR status != "SUCCEEDED")
  `;
}

export function createEnrichmentRetryStore({ bigqueryClient } = {}) {
  const client = bigqueryClient || bq;

  const getDueEnrichmentRetries = async ({ limit = 50, now = new Date() }) => {
    const safeLimit = Number(limit) > 0 ? Number(limit) : 50;
    const nowIso = now.toISOString();
    const options = {
      query: buildLatestEnrichmentRetryQuery({ limit: safeLimit }),
      params: {
        now: nowIso
      },
      parameterMode: "NAMED"
    };

    try {
      const [job] = await client.createQueryJob(options);
      const [rows] = await job.getQueryResults();
      return rows || [];
    } catch (error) {
      if (!isMissingColumnError(error, "created_at")) {
        throw error;
      }
      console.warn("enrich_retry_query_fallback: missing created_at, using legacy query");
      const fallbackOptions = {
        query: buildLegacyEnrichmentRetryQuery({ limit: safeLimit }),
        params: {
          now: nowIso
        },
        parameterMode: "NAMED"
      };
      const [job] = await client.createQueryJob(fallbackOptions);
      const [rows] = await job.getQueryResults();
      return rows || [];
    }
  };

  const getEnrichmentRetryStats = async ({ now = new Date() }) => {
    const nowIso = now.toISOString();
    const options = {
      query: buildEnrichmentRetryStatsQuery(),
      params: {
        now: nowIso
      },
      parameterMode: "NAMED"
    };

    try {
      const [job] = await client.createQueryJob(options);
      const [rows] = await job.getQueryResults();
      const row = rows?.[0] || {};
      return {
        notDue: Number(row.not_due || 0),
        totalPending: Number(row.total_pending || 0)
      };
    } catch (error) {
      if (!isMissingColumnError(error, "created_at")) {
        throw error;
      }
      console.warn("enrich_retry_stats_fallback: missing created_at, using legacy stats");
      const fallbackOptions = {
        query: buildLegacyEnrichmentRetryStatsQuery(),
        params: {
          now: nowIso
        },
        parameterMode: "NAMED"
      };
      const [job] = await client.createQueryJob(fallbackOptions);
      const [rows] = await job.getQueryResults();
      const row = rows?.[0] || {};
      return {
        notDue: Number(row.not_due || 0),
        totalPending: Number(row.total_pending || 0)
      };
    }
  };

  const insertEnrichmentRetryEvent = async ({
    expenseId,
    chatId,
    category,
    merchant,
    description,
    attempts = 0,
    nextAttemptAt,
    lastError,
    status = "PENDING",
    runId,
    eventId
  }) => {
    const table = client.dataset(BQ_DATASET).table(BQ_ENRICHMENT_RETRY_TABLE);
    const nowISO = new Date().toISOString();
    const fullRow = {
      event_id: String(eventId || crypto.randomUUID()),
      run_id: runId ? String(runId) : null,
      expense_id: String(expenseId),
      chat_id: String(chatId),
      status: String(status),
      category: category ? String(category) : null,
      merchant: merchant ? String(merchant) : null,
      description: description ? String(description) : null,
      attempts: Number(attempts || 0),
      next_attempt_at: nextAttemptAt || null,
      last_error: lastError || null,
      created_at: nowISO,
      updated_at: nowISO
    };

    try {
      await table.insert([fullRow], { skipInvalidRows: false, ignoreUnknownValues: true });
    } catch (error) {
      const legacyRow = {
        expense_id: String(expenseId),
        chat_id: String(chatId),
        status: String(status),
        category: category ? String(category) : null,
        merchant: merchant ? String(merchant) : null,
        description: description ? String(description) : null,
        attempts: Number(attempts || 0),
        next_attempt_at: nextAttemptAt || null,
        last_error: lastError || null
      };

      if (
        isMissingColumnError(error, "created_at") ||
        isMissingColumnError(error, "updated_at") ||
        isMissingColumnError(error, "event_id") ||
        isMissingColumnError(error, "run_id")
      ) {
        await table.insert([legacyRow], { skipInvalidRows: false, ignoreUnknownValues: true });
        return;
      }

      throw error;
    }
  };

  const getExpenseById = async ({ chatId, expenseId }) => {
    const query = `
      SELECT
        id,
        purchase_date,
        amount_mxn,
        payment_method,
        category,
        merchant,
        description,
        raw_text,
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

    const [job] = await client.createQueryJob(options);
    const [rows] = await job.getQueryResults();
    return rows?.[0] || null;
  };

  const updateExpenseEnrichment = async ({
    chatId,
    expenseId,
    category,
    merchant,
    description
  }) => {
    const query = `
      UPDATE \`${BQ_PROJECT_ID}.${BQ_DATASET}.${BQ_TABLE}\`
      SET
        category = @category,
        merchant = @merchant,
        description = @description
      WHERE chat_id = @chat_id
        AND id = @expense_id
    `;

    const options = {
      query,
      params: {
        chat_id: String(chatId),
        expense_id: String(expenseId),
        category: String(category || "Other"),
        merchant: merchant ? String(merchant) : null,
        description: description ? String(description) : null
      },
      parameterMode: "NAMED"
    };

    const [job] = await client.createQueryJob(options);
    await job.getQueryResults();
    const [metadata] = await job.getMetadata();
    const affected = Number(metadata?.statistics?.query?.numDmlAffectedRows || 0);
    if (!affected) {
      const err = new Error("BQ_UPDATE_NO_ROWS");
      err.code = "BQ_UPDATE_NO_ROWS";
      throw err;
    }

    return affected;
  };

  return {
    getDueEnrichmentRetries,
    getEnrichmentRetryStats,
    insertEnrichmentRetryEvent,
    getExpenseById,
    updateExpenseEnrichment
  };
}

export async function getDueEnrichmentRetries({ limit = 50, now = new Date() }) {
  return createEnrichmentRetryStore().getDueEnrichmentRetries({ limit, now });
}

export async function getEnrichmentRetryStats({ now = new Date() }) {
  return createEnrichmentRetryStore().getEnrichmentRetryStats({ now });
}

export async function insertEnrichmentRetryEvent({
  expenseId,
  chatId,
  category,
  merchant,
  description,
  attempts = 0,
  nextAttemptAt,
  lastError,
  status = "PENDING",
  runId,
  eventId
}) {
  return createEnrichmentRetryStore().insertEnrichmentRetryEvent({
    expenseId,
    chatId,
    category,
    merchant,
    description,
    attempts,
    nextAttemptAt,
    lastError,
    status,
    runId,
    eventId
  });
}

/* =======================
 * MSI: cashflow_month ("mes en que se paga") para una compra
 * ======================= */
export async function getBillingMonthForPurchase({
  chatId,
  cardName,
  purchaseDateISO,
  getCardRuleFn = getCardRuleWithMeta,
  cacheMeta
}) {
  const { rule, cacheHit } = await getCardRuleFn(chatId, cardName);
  if (cacheMeta && typeof cacheMeta === "object") {
    cacheMeta.card_rules = cacheHit;
  }

  if (!rule) {
    throw new Error(`No billing_month found for ${cardName} ${purchaseDateISO}`);
  }

  const purchaseDate = dateAtNoonUTC(purchaseDateISO);
  const purchaseDay = purchaseDate.getUTCDate();
  const cutDay = Number(rule.cut_day);
  const payOffsetDays = Number(rule.pay_offset_days || 0);
  const rollWeekendToMonday = Boolean(rule.roll_weekend_to_monday);

  let cutYear = purchaseDate.getUTCFullYear();
  let cutMonth = purchaseDate.getUTCMonth() + 1;

  if (purchaseDay > cutDay) {
    cutMonth += 1;
    if (cutMonth === 13) {
      cutMonth = 1;
      cutYear += 1;
    }
  }

  const cutDate = new Date(
    Date.UTC(cutYear, cutMonth - 1, clampDay(cutYear, cutMonth, cutDay), 12, 0, 0)
  );

  const payDate = new Date(cutDate);
  payDate.setUTCDate(payDate.getUTCDate() + payOffsetDays);

  if (rollWeekendToMonday) {
    const weekday = payDate.getUTCDay();
    if (weekday === 6) {
      payDate.setUTCDate(payDate.getUTCDate() + 2);
    } else if (weekday === 0) {
      payDate.setUTCDate(payDate.getUTCDate() + 1);
    }
  }

  const cashflowMonth = new Date(
    Date.UTC(payDate.getUTCFullYear(), payDate.getUTCMonth(), 1, 12, 0, 0)
  );

  return normalizeDateISO(cashflowMonth); // 'YYYY-MM-01'
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
    user_id: draft.user_id ? String(draft.user_id) : null,

    is_msi: isMsi,
    msi_months: isMsi ? msiMonths : null,
    msi_start_month: isMsi ? normalizeDateISO(billingMonthISO) : null, // primer billing month (mes B)
    msi_total_amount: isMsi ? money2(msiTotal) : null,
    original_amount: isMsi ? money2(msiTotal) : money2(draft.amount_mxn),
    original_currency: String(draft.currency || "MXN").toUpperCase(),
    amount_mxn_source: "manual"
  };

  if (draft.trip_id) {
    row.trip_id = String(draft.trip_id);
  }

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
      merchant,
      description,
      raw_text,
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
    DELETE FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.installments\`
    WHERE chat_id = @chat_id
      AND expense_id = @expense_id;
    SET deleted_installments = @@row_count;

    DELETE FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.${BQ_TABLE}\`
    WHERE chat_id = @chat_id
      AND id = @expense_id;
    SET deleted_expense = @@row_count;
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

/* =======================
 * Ledger: accounts
 * ======================= */
export async function listAccounts({ chatId, activeOnly = true }) {
  const query = `
    SELECT
      account_id,
      chat_id,
      account_name,
      institution,
      account_type,
      currency,
      active,
      tags,
      notes,
      created_at,
      updated_at
    FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.accounts\`
    WHERE chat_id = @chat_id
      ${activeOnly ? "AND active = TRUE" : ""}
    ORDER BY created_at ASC
  `;

  const options = {
    query,
    params: {
      chat_id: String(chatId)
    },
    parameterMode: "NAMED"
  };

  const [job] = await bq.createQueryJob(options);
  const [rows] = await job.getQueryResults();
  return rows || [];
}

export async function createAccount({
  chatId,
  accountName,
  institution,
  accountType,
  currency = "MXN",
  tags = null,
  notes = null
}) {
  const table = bq.dataset(BQ_DATASET).table("accounts");
  const now = new Date().toISOString();
  const row = {
    account_id: crypto.randomUUID(),
    chat_id: String(chatId),
    account_name: accountName,
    institution: institution || null,
    account_type: accountType,
    currency: currency || "MXN",
    active: true,
    tags,
    notes,
    created_at: now,
    updated_at: now
  };

  await table.insert([row], { skipInvalidRows: false, ignoreUnknownValues: false });
  return row;
}

/* =======================
 * Ledger: movements
 * ======================= */
export async function insertLedgerMovement(draft, chatId) {
  const table = bq.dataset(BQ_DATASET).table("ledger_movements");
  const row = {
    movement_id: crypto.randomUUID(),
    chat_id: String(chatId),
    movement_date: draft.movement_date,
    amount_mxn: money2(draft.amount_mxn),
    type: draft.movement_type,
    from_account_id: draft.from_account_id || null,
    to_account_id: draft.to_account_id || null,
    merchant: draft.merchant || null,
    notes: draft.notes || null,
    raw_text: draft.raw_text || null,
    source: draft.source || "telegram",
    created_at: new Date().toISOString()
  };

  await table.insert([row], { skipInvalidRows: false, ignoreUnknownValues: false });
  return row.movement_id;
}

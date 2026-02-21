import { getCashflowMonthForPurchase } from "./cashflow.js";
import { getMonthRange, normalizeMonthStart } from "./months.js";
import {
  consumeLinkToken,
  ensureUserExists,
  getAuthenticatedEmail,
  resolveLinkedChatId
} from "./dashboard_identity.js";

function requiredEnv(env, name) {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing env ${name}`);
  }
  return value;
}

function validateToken(env, token) {
  const expected = env.DASHBOARD_TOKEN;
  if (!expected) {
    throw new Error("Missing DASHBOARD_TOKEN");
  }
  return token === expected;
}

function parseMonthParam(value) {
  const normalized = normalizeMonthStart(value);
  if (!normalized) return null;
  return normalized;
}

function buildMonths(fromISO, toISO) {
  return getMonthRange(fromISO, toISO);
}

async function fetchCardRules({ bq, env, chatId }) {
  const dataset = requiredEnv(env, "BQ_DATASET");
  const query = `
    SELECT card_name, cut_day, pay_offset_days, roll_weekend_to_monday
    FROM \`${requiredEnv(env, "BQ_PROJECT_ID")}.${dataset}.card_rules\`
    WHERE chat_id = @chat_id AND active = true
    ORDER BY card_name
  `;

  const [rows] = await bq.query({
    query,
    params: { chat_id: String(chatId) }
  });

  return rows.map((row) => ({
    card_name: row.card_name,
    cut_day: Number(row.cut_day),
    pay_offset_days: Number(row.pay_offset_days || 0),
    roll_weekend_to_monday: Boolean(row.roll_weekend_to_monday)
  }));
}

async function fetchNoMsiAggregates({ bq, env, chatId, fromISO, toISO }) {
  const dataset = requiredEnv(env, "BQ_DATASET");
  const query = `
    SELECT payment_method AS card_name, purchase_date, SUM(amount_mxn) AS total
    FROM \`${requiredEnv(env, "BQ_PROJECT_ID")}.${dataset}.${requiredEnv(env, "BQ_TABLE")}\`
    WHERE chat_id = @chat_id
      AND (is_msi IS NULL OR is_msi = false)
      AND purchase_date BETWEEN DATE(@from_date) AND DATE(@to_date)
    GROUP BY card_name, purchase_date
  `;

  const [rows] = await bq.query({
    query,
    params: {
      chat_id: String(chatId),
      from_date: fromISO,
      to_date: toISO
    }
  });

  return rows.map((row) => ({
    card_name: row.card_name,
    purchase_date: row.purchase_date.value ?? row.purchase_date,
    total: Number(row.total || 0)
  }));
}

async function fetchMsiAggregates({ bq, env, chatId, fromISO, toISO }) {
  const dataset = requiredEnv(env, "BQ_DATASET");
  const query = `
    SELECT card_name, billing_month, SUM(amount_mxn) AS total
    FROM \`${requiredEnv(env, "BQ_PROJECT_ID")}.${dataset}.installments\`
    WHERE chat_id = @chat_id
      AND billing_month BETWEEN DATE(@from_date) AND DATE(@to_date)
    GROUP BY card_name, billing_month
  `;

  const [rows] = await bq.query({
    query,
    params: {
      chat_id: String(chatId),
      from_date: fromISO,
      to_date: toISO
    }
  });

  return rows.map((row) => ({
    card_name: row.card_name,
    billing_month: row.billing_month.value ?? row.billing_month,
    total: Number(row.total || 0)
  }));
}

function addToTotals(target, key, amount) {
  const current = target[key] ?? 0;
  target[key] = current + amount;
}

async function resolveAuthorizedChatId({ request, bq, env }) {
  const { searchParams } = new URL(request.url);
  const legacyToken = searchParams.get("token");
  const legacyChatId = searchParams.get("chat_id");

  if (legacyToken && legacyChatId) {
    if (!validateToken(env, legacyToken)) {
      throw new Error("Unauthorized");
    }
    return String(legacyChatId);
  }

  const email = getAuthenticatedEmail(request);
  if (!email) {
    throw new Error("Missing authenticated user email");
  }

  const projectId = requiredEnv(env, "BQ_PROJECT_ID");
  const dataset = requiredEnv(env, "BQ_DATASET");
  const linkToken = searchParams.get("link_token");

  const { userId } = await ensureUserExists({ bq, projectId, dataset, email });

  if (linkToken) {
    await consumeLinkToken({
      bq,
      projectId,
      dataset,
      linkToken,
      userId,
      email
    });
  }

  const chatId = await resolveLinkedChatId({ bq, projectId, dataset, userId });
  if (!chatId) {
    throw new Error("No Telegram chat linked to this user. Open /dashboard from the bot first.");
  }

  return chatId;
}

export async function handleCashflowRequest({ request, bq, env }) {
  try {
    const { searchParams } = new URL(request.url);
    const from = searchParams.get("from");
    const to = searchParams.get("to");

    const fromISO = parseMonthParam(from);
    const toISO = parseMonthParam(to);

    if (!fromISO || !toISO) {
      return new Response("Invalid from/to", { status: 400 });
    }

    const chatId = await resolveAuthorizedChatId({ request, bq, env });

    const months = buildMonths(fromISO, toISO);
    const [cardRules, noMsiRows, msiRows] = await Promise.all([
      fetchCardRules({ bq, env, chatId }),
      fetchNoMsiAggregates({ bq, env, chatId, fromISO, toISO }),
      fetchMsiAggregates({ bq, env, chatId, fromISO, toISO })
    ]);

    const rowsByCard = new Map();
    cardRules.forEach((rule) => {
      rowsByCard.set(rule.card_name, { card_name: rule.card_name, totals: {} });
    });

    const cardRuleMap = new Map();
    cardRules.forEach((rule) => cardRuleMap.set(rule.card_name, rule));

    noMsiRows.forEach((row) => {
      const rule = cardRuleMap.get(row.card_name);
      if (!rule) return;
      const cashflowMonth = getCashflowMonthForPurchase({
        purchaseDateISO: row.purchase_date,
        cutDay: rule.cut_day,
        payOffsetDays: rule.pay_offset_days,
        rollWeekendToMonday: rule.roll_weekend_to_monday
      });
      const ym = cashflowMonth.slice(0, 7);
      const entry = rowsByCard.get(row.card_name);
      addToTotals(entry.totals, ym, row.total);
    });

    msiRows.forEach((row) => {
      const ym = String(row.billing_month).slice(0, 7);
      const entry = rowsByCard.get(row.card_name) ?? {
        card_name: row.card_name,
        totals: {}
      };
      addToTotals(entry.totals, ym, row.total);
      rowsByCard.set(row.card_name, entry);
    });

    const totals = {};
    months.forEach((month) => {
      totals[month] = 0;
    });

    const rows = Array.from(rowsByCard.values());
    rows.forEach((row) => {
      months.forEach((month) => {
        const value = row.totals[month] ?? 0;
        totals[month] += value;
      });
    });

    return Response.json({ months, rows, totals });
  } catch (error) {
    const status =
      error.message === "Unauthorized"
        ? 401
        : error.message.startsWith("Missing authenticated user") ||
            error.message.startsWith("No Telegram chat linked") ||
            error.message.startsWith("Invalid or expired link_token")
          ? 403
          : 500;

    return new Response(error.message ?? "Server error", { status });
  }
}

import bigqueryPkg from "@google-cloud/bigquery";
import { BQ_PROJECT_ID, BQ_DATASET } from "../config.js";

const { BigQuery } = bigqueryPkg;
const bq = new BigQuery({ projectId: BQ_PROJECT_ID });

const CACHE_TTL_MS = Number(process.env.CARD_RULES_CACHE_TTL_MS || 10 * 60 * 1000);
const cacheByChat = new Map();

let fetchActiveRules = defaultFetchActiveRules;

function normalizeChatId(chatId) {
  if (chatId == null) return "__all__";
  return String(chatId);
}

async function defaultFetchActiveRules(chatId) {
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
      ${chatId != null ? "AND chat_id = @chat_id" : ""}
  `;

  const options =
    chatId != null
      ? { query, params: { chat_id: String(chatId) }, parameterMode: "NAMED" }
      : { query };

  const [job] = await bq.createQueryJob(options);
  const [rows] = await job.getQueryResults();
  return rows || [];
}

function buildCacheEntry(rows) {
  const rulesByCard = new Map();
  const activeCardNames = [];
  const rules = [];
  for (const row of rows) {
    const cardName = String(row.card_name);
    rulesByCard.set(cardName, row);
    activeCardNames.push(cardName);
    rules.push(row);
  }
  return {
    rulesByCard,
    activeCardNames,
    rules,
    expiresAt: Date.now() + CACHE_TTL_MS
  };
}

async function refreshIfNeeded(chatId) {
  const key = normalizeChatId(chatId);
  const now = Date.now();
  const existing = cacheByChat.get(key);

  if (existing && now < existing.expiresAt) {
    return { entry: existing, cacheHit: true };
  }

  if (existing?.refreshPromise) {
    await existing.refreshPromise;
    const next = cacheByChat.get(key);
    return { entry: next, cacheHit: false };
  }

  const refreshPromise = (async () => {
    const rows = await fetchActiveRules(chatId);
    const entry = buildCacheEntry(rows);
    cacheByChat.set(key, entry);
    return entry;
  })();

  cacheByChat.set(key, { ...existing, refreshPromise });

  const entry = await refreshPromise;
  return { entry, cacheHit: false };
}

export async function getCardRuleWithMeta(chatId, cardName) {
  const { entry, cacheHit } = await refreshIfNeeded(chatId);
  const rule = entry?.rulesByCard?.get(String(cardName)) || null;
  return { rule, cacheHit };
}

export async function getCardRule(chatId, cardName) {
  const { rule } = await getCardRuleWithMeta(chatId, cardName);
  return rule;
}

export async function getActiveCardNames(chatId) {
  const { entry } = await refreshIfNeeded(chatId);
  return entry?.activeCardNames ? [...entry.activeCardNames] : [];
}

export async function getActiveCardRules(chatId) {
  const { entry } = await refreshIfNeeded(chatId);
  return entry?.rules ? [...entry.rules] : [];
}

export function __setFetchActiveRules(fn) {
  fetchActiveRules = fn;
}

export function __resetCardRulesCache() {
  cacheByChat.clear();
  fetchActiveRules = defaultFetchActiveRules;
}

import { tgSend, escapeHtml } from "./telegram.js";
import {
  getActiveCardRules,
  getCardCashflowTotal,
  sumExpensesForCycle,
  alreadySentReminder,
  logReminderSent
} from "./storage/bigquery.js";
import { todayISOInTZ } from "./parsing.js";
import {
  addDaysISO,
  addMonthsISO,
  buildCutAndPayDates,
  cutISOForYM,
  makeISODate,
  prevYM,
  rollWeekendToMonday,
  startOfMonthISO,
  ymFromISO
} from "./analysis/date_utils.js";

function formatMoneyMXN(n) {
  const x = Number(n || 0);
  return x.toLocaleString("es-MX", { style: "currency", currency: "MXN" });
}

function logPerf(payload, level = "log") {
  const base = { type: "perf", ...payload };
  if (level === "warn") {
    console.warn(JSON.stringify(base));
  } else {
    console.log(JSON.stringify(base));
  }
}

const paymentReminderCache = new Map();

function paymentReminderKey({ chatId, cardName }) {
  return `${chatId}|${cardName}`;
}

function wasPaymentReminderSent({ todayISO, chatId, cardName }) {
  const key = paymentReminderKey({ chatId, cardName });
  return paymentReminderCache.get(key) === todayISO;
}

function markPaymentReminderSent({ todayISO, chatId, cardName }) {
  const key = paymentReminderKey({ chatId, cardName });
  paymentReminderCache.set(key, todayISO);
}

export function getNextPayDateISO({
  todayISO,
  cutDay,
  payOffsetDays,
  rollWeekendToMonday: rollWeekend = false,
  includeToday = false
}) {
  const { y, m } = ymFromISO(todayISO);
  const current = buildCutAndPayDates({
    year: y,
    month: m,
    cutDay,
    payOffsetDays,
    rollWeekendToMonday: rollWeekend
  });

  if (includeToday ? current.payISO >= todayISO : current.payISO > todayISO) {
    return current.payISO;
  }

  const nextMonthISO = addMonthsISO(makeISODate(y, m, 1), 1);
  const { y: ny, m: nm } = ymFromISO(nextMonthISO);
  const next = buildCutAndPayDates({
    year: ny,
    month: nm,
    cutDay,
    payOffsetDays,
    rollWeekendToMonday: rollWeekend
  });
  return next.payISO;
}

export function isPayDateTomorrow({
  todayISO,
  cutDay,
  payOffsetDays,
  rollWeekendToMonday: rollWeekend = false
}) {
  const tomorrowISO = addDaysISO(todayISO, 1);
  const nextPayISO = getNextPayDateISO({
    todayISO,
    cutDay,
    payOffsetDays,
    rollWeekendToMonday: rollWeekend
  });
  return nextPayISO === tomorrowISO;
}

// ✅ CAMBIO 1: acepta { force }
export async function runDailyCardReminders({ force = false, requestId = null } = {}) {
  const startMs = Date.now();
  let bqMs = 0;
  const todayISO = todayISOInTZ(); // CDMX

  const rulesStart = Date.now();
  const rules = await getActiveCardRules();
  bqMs += Date.now() - rulesStart;

  for (const r of rules) {
    const { y, m } = ymFromISO(todayISO);

    const cutISO = cutISOForYM(y, m, r.cut_day);

    if (todayISO !== cutISO) continue;

    // ✅ CAMBIO 2: si force=true, no dedupe
    if (!force) {
      const alreadyStart = Date.now();
      const already = await alreadySentReminder({
        chatId: r.chat_id,
        cardName: r.card_name,
        cutISO
      });
      bqMs += Date.now() - alreadyStart;
      if (already) continue;
    }

    const { y: py, m: pm } = prevYM(y, m);
    const prevCutISO = cutISOForYM(py, pm, r.cut_day);

    const startISO = addDaysISO(prevCutISO, 1);
    const endISO = cutISO;

    const sumStart = Date.now();
    const total = await sumExpensesForCycle({
      chatId: r.chat_id,
      cardName: r.card_name,
      startISO,
      endISO
    });
    bqMs += Date.now() - sumStart;

    let payISO = addDaysISO(cutISO, r.pay_offset_days);
    if (r.roll_weekend_to_monday) payISO = rollWeekendToMonday(payISO);

    const msg = [
      `💳 <b>Hoy es corte</b> de <b>${escapeHtml(r.card_name)}</b>`,
      `Periodo: <code>${escapeHtml(startISO)}</code> a <code>${escapeHtml(endISO)}</code>`,
      `Total registrado (sin MSI detectados): <b>${escapeHtml(formatMoneyMXN(total))}</b>`,
      `Fecha estimada de pago: <b>${escapeHtml(payISO)}</b>`
    ].join("\n");

    await tgSend(r.chat_id, msg);

    const logStart = Date.now();
    await logReminderSent({
      chatId: r.chat_id,
      cardName: r.card_name,
      cutISO
    });
    bqMs += Date.now() - logStart;
  }

  const totalMs = Date.now() - startMs;
  logPerf({
    request_id: requestId,
    flow: "reminder",
    option: "RUN",
    chat_id: null,
    local_parse_ms: 0,
    llm_ms: 0,
    bq_ms: bqMs,
    total_ms: totalMs,
    llm_provider: null,
    cache_hit: { card_rules: null, llm: false },
    status: "ok"
  });

  return { ok: true, todayISO, processed: rules.length, bqMs };
}

export async function runPaymentDateReminders({
  limitChats = 50,
  todayISO = todayISOInTZ(),
  getActiveCardRulesFn = getActiveCardRules,
  getCardCashflowTotalFn = getCardCashflowTotal,
  sendMessageFn = tgSend,
  requestId = null
} = {}) {
  const startMs = Date.now();
  let bqMs = 0;
  let scannedCards = 0;
  let dueTomorrow = 0;
  let sent = 0;
  let skipped = 0;

  const rulesStart = Date.now();
  const rules = await getActiveCardRulesFn();
  bqMs += Date.now() - rulesStart;

  const tomorrowISO = addDaysISO(todayISO, 1);
  const chatLimit = Number.isFinite(Number(limitChats)) ? Number(limitChats) : 50;
  const seenChats = new Set();

  for (const rule of rules) {
    const chatId = String(rule.chat_id);
    if (!seenChats.has(chatId)) {
      if (seenChats.size >= chatLimit) continue;
      seenChats.add(chatId);
    }

    scannedCards += 1;

    const nextPayISO = getNextPayDateISO({
      todayISO,
      cutDay: Number(rule.cut_day),
      payOffsetDays: Number(rule.pay_offset_days || 0),
      rollWeekendToMonday: Boolean(rule.roll_weekend_to_monday)
    });

    if (nextPayISO !== tomorrowISO) continue;

    dueTomorrow += 1;

    if (wasPaymentReminderSent({ todayISO, chatId, cardName: rule.card_name })) {
      skipped += 1;
      continue;
    }

    let total = null;
    let cashflowMonthISO = startOfMonthISO(nextPayISO);
    try {
      const sumStart = Date.now();
      total = await getCardCashflowTotalFn({
        chatId,
        cardName: rule.card_name,
        monthISO: cashflowMonthISO
      });
      bqMs += Date.now() - sumStart;
    } catch (e) {
      console.error(
        `payment reminder: failed cashflow total for ${chatId} ${rule.card_name}`,
        e
      );
      total = null;
      cashflowMonthISO = null;
    }

    const monthLabel = cashflowMonthISO ? cashflowMonthISO.slice(0, 7) : null;
    const lines = [
      "💳 Recordatorio de pago",
      "",
      `Mañana es la fecha de pago de: ${escapeHtml(rule.card_name)}`
    ];

    if (total !== null) {
      lines.push(`Total estimado: ${escapeHtml(formatMoneyMXN(total))} MXN`);
      lines.push("");
      lines.push(`(Estimación basada en gastos con cashflow en ${escapeHtml(monthLabel)})`);
    }

    await sendMessageFn(chatId, lines.join("\n"));
    markPaymentReminderSent({ todayISO, chatId, cardName: rule.card_name });
    sent += 1;
  }

  const totalMs = Date.now() - startMs;
  logPerf({
    request_id: requestId,
    flow: "reminder",
    option: "PAYMENT_REMINDER",
    chat_id: null,
    local_parse_ms: 0,
    llm_ms: 0,
    bq_ms: bqMs,
    total_ms: totalMs,
    llm_provider: null,
    cache_hit: { card_rules: null, llm: false },
    status: "ok"
  });

  return {
    ok: true,
    scanned_cards: scannedCards,
    due_tomorrow: dueTomorrow,
    sent,
    skipped,
    bq_ms: bqMs,
    total_ms: totalMs
  };
}

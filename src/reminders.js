import { tgSend, escapeHtml } from "./telegram.js";
import {
  getActiveCardRules,
  sumExpensesForCycle,
  alreadySentReminder,
  logReminderSent
} from "./storage/bigquery.js";
import { todayISOInTZ } from "./parsing.js";

// --- Date helpers (robustos contra TZ/DST) ---
function dateAtNoonUTC(iso) {
  return new Date(`${iso}T12:00:00Z`);
}
function isoFromDateUTC(d) {
  return d.toISOString().slice(0, 10);
}
function addDaysISO(iso, days) {
  const d = dateAtNoonUTC(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return isoFromDateUTC(d);
}
function lastDayOfMonth(year, month1to12) {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}
function clampDay(year, month1to12, day) {
  return Math.min(day, lastDayOfMonth(year, month1to12));
}
function makeISODate(year, month1to12, day) {
  const mm = String(month1to12).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}
function weekdayUTC(iso) {
  return dateAtNoonUTC(iso).getUTCDay(); // 0=Sun 6=Sat
}
function rollWeekendToMonday(iso) {
  const wd = weekdayUTC(iso);
  if (wd === 6) return addDaysISO(iso, 2);
  if (wd === 0) return addDaysISO(iso, 1);
  return iso;
}

function ymFromISO(todayISO) {
  const d = dateAtNoonUTC(todayISO);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
}
function prevYM(y, m) {
  m -= 1;
  if (m === 0) return { y: y - 1, m: 12 };
  return { y, m };
}
function cutISOForYM(y, m, cut_day) {
  const cd = clampDay(y, m, cut_day);
  return makeISODate(y, m, cd);
}

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

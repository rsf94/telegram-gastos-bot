import { tgSend, escapeHtml } from "./telegram.js";
import { getActiveCardRules, sumExpensesForCycle } from "./storage/bigquery.js";
import { todayISOInTZ } from "./parsing.js"; // tu helper CDMX

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
  // month1to12: 1..12
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate(); // day 0 of next month
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
  // 0=Sun 6=Sat
  return dateAtNoonUTC(iso).getUTCDay();
}
function rollWeekendToMonday(iso) {
  const wd = weekdayUTC(iso);
  if (wd === 6) return addDaysISO(iso, 2); // Sat -> Mon
  if (wd === 0) return addDaysISO(iso, 1); // Sun -> Mon
  return iso;
}

// cutoff for current month using cut_day; if month doesn't have that day -> last day.
function cutDateForMonth(todayISO, cut_day) {
  const d = dateAtNoonUTC(todayISO);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1; // 1..12
  const cd = clampDay(y, m, cut_day);
  return makeISODate(y, m, cd);
}

function prevMonth(todayISO) {
  const d = dateAtNoonUTC(todayISO);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth() + 1;
  m -= 1;
  if (m === 0) { m = 12; y -= 1; }
  return { y, m };
}

function prevCutDate(todayISO, cut_day) {
  const d = dateAtNoonUTC(todayISO);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const thisCut = makeISODate(y, m, clampDay(y, m, cut_day));

  // si hoy todavía no llega al corte del mes, el corte anterior es el del mes pasado
  if (todayISO < thisCut) {
    const pm = prevMonth(todayISO);
    return makeISODate(pm.y, pm.m, clampDay(pm.y, pm.m, cut_day));
  }
  // si hoy ya pasó (o es) el corte, el corte anterior es el del mes pasado también
  const pm = prevMonth(todayISO);
  return makeISODate(pm.y, pm.m, clampDay(pm.y, pm.m, cut_day));
}

function formatMoneyMXN(n) {
  const x = Number(n || 0);
  return x.toLocaleString("es-MX", { style: "currency", currency: "MXN" });
}

export async function runDailyCardReminders() {
  const todayISO = todayISOInTZ(); // CDMX (tu helper)

  const rules = await getActiveCardRules();
  // rules: [{chat_id, card_name, cut_day, pay_offset_days, roll_weekend_to_monday, active}, ...]

  // Procesa por regla
  for (const r of rules) {
    const cutISO = cutDateForMonth(todayISO, r.cut_day);

    // Solo disparamos si HOY es corte
    if (todayISO !== cutISO) continue;

    // ciclo: (prevCut + 1) ... cut
    const prevCutISO = prevCutDate(todayISO, r.cut_day);
    const startISO = addDaysISO(prevCutISO, 1);
    const endISO = cutISO;

    const total = await sumExpensesForCycle({
      chatId: r.chat_id,
      cardName: r.card_name,
      startISO,
      endISO
    });

    let payISO = addDaysISO(cutISO, r.pay_offset_days);
    if (r.roll_weekend_to_monday) payISO = rollWeekendToMonday(payISO);

    const msg = [
      `💳 <b>Hoy es corte</b> de <b>${escapeHtml(r.card_name)}</b>`,
      `Periodo: <code>${escapeHtml(startISO)}</code> a <code>${escapeHtml(endISO)}</code>`,
      `Total registrado (sin MSI detectados): <b>${escapeHtml(formatMoneyMXN(total))}</b>`,
      `Fecha estimada de pago: <b>${escapeHtml(payISO)}</b>`
    ].join("\n");

    await tgSend(r.chat_id, msg);
  }

  return { ok: true, todayISO, processed: rules.length };
}

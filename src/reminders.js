import { tgSend, escapeHtml } from "./telegram.js";
import { getActiveCardRules, sumExpensesForCycle } from "./storage/bigquery.js";
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

export async function runDailyCardReminders() {
  const todayISO = todayISOInTZ(); // CDMX

  const rules = await getActiveCardRules();

  for (const r of rules) {
    const { y, m } = ymFromISO(todayISO);

    // corte del mes actual (clamp a último día si el mes no tiene cut_day)
    const cutISO = cutISOForYM(y, m, r.cut_day);

    // Solo disparamos si HOY es corte
    if (todayISO !== cutISO) continue;

    // corte anterior = corte del mes pasado
    const { y: py, m: pm } = prevYM(y, m);
    const prevCutISO = cutISOForYM(py, pm, r.cut_day);

    // ciclo: (prevCut + 1) ... cut
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

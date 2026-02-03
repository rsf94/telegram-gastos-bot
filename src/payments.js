import { addDaysISO, dateAtNoonUTC, weekdayShortEs } from "./analysis/date_utils.js";
import { getNextPayDateISO } from "./reminders.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysBetweenISO(startISO, endISO) {
  const start = dateAtNoonUTC(startISO);
  const end = dateAtNoonUTC(endISO);
  return Math.round((end - start) / MS_PER_DAY);
}

export function getUpcomingPaymentDates({ todayISO, rules }) {
  const entries = (rules || [])
    .filter((rule) => rule?.active !== false)
    .map((rule) => {
      const payISO = getNextPayDateISO({
        todayISO,
        cutDay: Number(rule.cut_day),
        payOffsetDays: Number(rule.pay_offset_days || 0),
        rollWeekendToMonday: Boolean(rule.roll_weekend_to_monday),
        includeToday: true
      });
      const reminderISO = addDaysISO(payISO, -1);
      const daysUntil = daysBetweenISO(todayISO, payISO);
      return {
        cardName: String(rule.card_name),
        payISO,
        reminderISO,
        daysUntil,
        weekday: weekdayShortEs(payISO)
      };
    })
    .sort((a, b) => {
      if (a.payISO !== b.payISO) return a.payISO.localeCompare(b.payISO);
      return a.cardName.localeCompare(b.cardName);
    });

  const earliestPayDate = entries[0]?.payISO || null;
  const latestPayDate = entries[entries.length - 1]?.payISO || null;

  return {
    entries,
    scannedCards: entries.length,
    earliestPayDate,
    latestPayDate
  };
}

export function buildUpcomingPaymentsReport({ todayISO, rules, escapeHtmlFn = (x) => x }) {
  const { entries, scannedCards, earliestPayDate, latestPayDate } =
    getUpcomingPaymentDates({ todayISO, rules });

  const lines = ["📅 Próximos pagos"];

  if (!entries.length) {
    lines.push("No encontré tarjetas activas.");
  } else {
    for (const entry of entries) {
      lines.push(
        `• ${escapeHtmlFn(entry.cardName)} — pago: ${entry.payISO} (${entry.weekday}) — recordatorio: ${entry.reminderISO} — en ${entry.daysUntil} días`
      );
    }
  }

  lines.push(
    "",
    `Tarjetas activas: ${scannedCards}`,
    `Fecha más próxima: ${earliestPayDate || "—"}`,
    `Fecha más lejana: ${latestPayDate || "—"}`
  );

  return {
    text: lines.join("\n"),
    scannedCards,
    earliestPayDate,
    latestPayDate
  };
}

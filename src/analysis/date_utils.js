export function dateAtNoonUTC(iso) {
  return new Date(`${iso}T12:00:00Z`);
}

export function isoFromDateUTC(d) {
  return d.toISOString().slice(0, 10);
}

export function addDaysISO(iso, days) {
  const d = dateAtNoonUTC(iso);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return isoFromDateUTC(d);
}

export function addMonthsISO(iso, months) {
  const d = dateAtNoonUTC(iso);
  const delta = Number(months || 0);
  d.setUTCMonth(d.getUTCMonth() + delta, 1);
  return isoFromDateUTC(d);
}

export function lastDayOfMonth(year, month1to12) {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

export function clampDay(year, month1to12, day) {
  return Math.min(day, lastDayOfMonth(year, month1to12));
}

export function makeISODate(year, month1to12, day) {
  const mm = String(month1to12).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

export function rollWeekendToMonday(iso) {
  const wd = dateAtNoonUTC(iso).getUTCDay();
  if (wd === 6) return addDaysISO(iso, 2);
  if (wd === 0) return addDaysISO(iso, 1);
  return iso;
}

export function weekdayShortEs(iso) {
  const wd = dateAtNoonUTC(iso).getUTCDay();
  const labels = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
  return labels[wd] || "";
}

export function ymFromISO(iso) {
  const d = dateAtNoonUTC(iso);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
}

export function prevYM(y, m) {
  const month = m - 1;
  if (month === 0) return { y: y - 1, m: 12 };
  return { y, m: month };
}

export function startOfMonthISO(iso) {
  const { y, m } = ymFromISO(iso);
  return makeISODate(y, m, 1);
}

export function isSameMonthISO(aISO, bISO) {
  return startOfMonthISO(aISO) === startOfMonthISO(bISO);
}

export function cutISOForYM(y, m, cutDay) {
  const cd = clampDay(y, m, cutDay);
  return makeISODate(y, m, cd);
}

export function buildCutAndPayDates({
  year,
  month,
  cutDay,
  payOffsetDays,
  rollWeekendToMonday: rollWeekend = false
}) {
  const cutISO = cutISOForYM(year, month, cutDay);
  let payISO = addDaysISO(cutISO, payOffsetDays);
  if (rollWeekend) {
    payISO = rollWeekendToMonday(payISO);
  }
  return { cutISO, payISO };
}

export function statementMonthISO(cutISO) {
  return startOfMonthISO(cutISO);
}

export function resolveStatementForPayMonth({
  payMonthISO,
  cutDay,
  payOffsetDays,
  rollWeekendToMonday: rollWeekend = false
}) {
  const { y, m } = ymFromISO(payMonthISO);
  const candidate = buildCutAndPayDates({
    year: y,
    month: m,
    cutDay,
    payOffsetDays,
    rollWeekendToMonday: rollWeekend
  });

  if (isSameMonthISO(candidate.payISO, payMonthISO)) {
    return { cutISO: candidate.cutISO, payISO: candidate.payISO, cutYear: y, cutMonth: m };
  }

  const { y: py, m: pm } = prevYM(y, m);
  const prevCandidate = buildCutAndPayDates({
    year: py,
    month: pm,
    cutDay,
    payOffsetDays,
    rollWeekendToMonday: rollWeekend
  });

  if (isSameMonthISO(prevCandidate.payISO, payMonthISO)) {
    return {
      cutISO: prevCandidate.cutISO,
      payISO: prevCandidate.payISO,
      cutYear: py,
      cutMonth: pm
    };
  }

  return { cutISO: candidate.cutISO, payISO: candidate.payISO, cutYear: y, cutMonth: m };
}

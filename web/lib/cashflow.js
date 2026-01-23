import { clampDay, dateAtNoonUTC, makeISODate, rollWeekendToMonday, startOfMonthISO } from "./date_utils.js";

export function getCashflowMonthForPurchase({
  purchaseDateISO,
  cutDay,
  payOffsetDays,
  rollWeekendToMonday: rollWeekend = false
}) {
  if (!purchaseDateISO) {
    throw new Error("purchaseDateISO is required");
  }

  const purchaseDate = dateAtNoonUTC(purchaseDateISO);
  const purchaseDay = purchaseDate.getUTCDate();
  const cutDayNum = Number(cutDay);
  const payOffset = Number(payOffsetDays || 0);

  let cutYear = purchaseDate.getUTCFullYear();
  let cutMonth = purchaseDate.getUTCMonth() + 1;

  if (purchaseDay > cutDayNum) {
    cutMonth += 1;
    if (cutMonth === 13) {
      cutMonth = 1;
      cutYear += 1;
    }
  }

  const cutISO = makeISODate(cutYear, cutMonth, clampDay(cutYear, cutMonth, cutDayNum));
  let payISO = makeISODate(cutYear, cutMonth, clampDay(cutYear, cutMonth, cutDayNum));
  const payDate = dateAtNoonUTC(payISO);
  payDate.setUTCDate(payDate.getUTCDate() + payOffset);
  payISO = payDate.toISOString().slice(0, 10);

  if (rollWeekend) {
    payISO = rollWeekendToMonday(payISO);
  }

  return startOfMonthISO(payISO);
}

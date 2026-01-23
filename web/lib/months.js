import { addMonthsISO, startOfMonthISO, ymFromISO } from "./date_utils.js";

export function normalizeMonthStart(iso) {
  if (!iso) return null;
  const match = /^\d{4}-\d{2}-\d{2}$/.exec(iso);
  if (!match) return null;
  return startOfMonthISO(iso);
}

export function monthToInputValue(iso) {
  if (!iso) return "";
  const { y, m } = ymFromISO(iso);
  return `${y}-${String(m).padStart(2, "0")}`;
}

export function getMonthRange(fromISO, toISO) {
  const months = [];
  let cursor = startOfMonthISO(fromISO);
  const end = startOfMonthISO(toISO);
  while (cursor <= end) {
    months.push(cursor.slice(0, 7));
    cursor = addMonthsISO(cursor, 1);
  }
  return months;
}

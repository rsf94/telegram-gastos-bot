import { getActiveCardNames } from "./storage/bigquery.js";

let cachedCards = [];
let lastFetch = 0;
const TTL_MS = 5 * 60 * 1000; // 5 minutos

export async function getAllowedPaymentMethods() {
  const now = Date.now();

  if (!cachedCards.length || now - lastFetch > TTL_MS) {
    cachedCards = await getActiveCardNames();
    lastFetch = now;
  }

  return cachedCards;
}

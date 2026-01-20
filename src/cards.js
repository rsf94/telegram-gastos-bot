import { getActiveCardNames as getActiveCardNamesCached } from "./cache/card_rules_cache.js";

export async function getAllowedPaymentMethods(chatId = null) {
  return getActiveCardNamesCached(chatId);
}

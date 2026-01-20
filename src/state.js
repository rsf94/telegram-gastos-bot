const draftByChat = new Map(); // chatId -> draft
const deleteByChat = new Map(); // chatId -> { expenseId, installmentsCount }
const lastExpenseByChat = new Map(); // chatId -> expenseId

export function getDraft(chatId) {
  return draftByChat.get(chatId);
}

export function setDraft(chatId, draft) {
  draftByChat.set(chatId, draft);
}

export function clearDraft(chatId) {
  draftByChat.delete(chatId);
}

export function getLastExpenseId(chatId) {
  return lastExpenseByChat.get(chatId);
}

export function setLastExpenseId(chatId, expenseId) {
  if (!expenseId) return;
  lastExpenseByChat.set(chatId, expenseId);
}

export function clearLastExpenseId(chatId) {
  lastExpenseByChat.delete(chatId);
}

export function getPendingDelete(chatId) {
  return deleteByChat.get(chatId);
}

export function setPendingDelete(chatId, pending) {
  deleteByChat.set(chatId, pending);
}

export function clearPendingDelete(chatId) {
  deleteByChat.delete(chatId);
}

export function clearAll(chatId) {
  clearDraft(chatId);
  clearPendingDelete(chatId);
  clearLastExpenseId(chatId);
}

export function __resetState() {
  draftByChat.clear();
  deleteByChat.clear();
  lastExpenseByChat.clear();
}

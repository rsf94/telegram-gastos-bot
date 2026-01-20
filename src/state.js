const draftByChat = new Map(); // chatId -> draft
const deleteByChat = new Map(); // chatId -> { expenseId, installmentsCount }

export function getDraft(chatId) {
  return draftByChat.get(chatId);
}

export function setDraft(chatId, draft) {
  draftByChat.set(chatId, draft);
}

export function clearDraft(chatId) {
  draftByChat.delete(chatId);
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
}

export function __resetState() {
  draftByChat.clear();
  deleteByChat.clear();
}

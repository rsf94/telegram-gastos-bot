export const DRAFT_STATES = {
  IDLE: "IDLE",
  PARSED: "PARSED",
  SELECT_METHOD: "SELECT_METHOD",
  CONFIRMATION: "CONFIRMATION"
};

export function step(draftState, event) {
  const state = draftState || DRAFT_STATES.IDLE;

  if (state === DRAFT_STATES.IDLE) {
    if (event?.type === "PARSE_OK") return DRAFT_STATES.PARSED;
    return state;
  }

  if (state === DRAFT_STATES.PARSED) {
    if (event?.type === "REQUEST_METHOD") return DRAFT_STATES.SELECT_METHOD;
    if (event?.type === "CANCEL") return DRAFT_STATES.IDLE;
    return state;
  }

  if (state === DRAFT_STATES.SELECT_METHOD) {
    if (event?.type === "METHOD_SELECTED") return DRAFT_STATES.CONFIRMATION;
    if (event?.type === "CANCEL") return DRAFT_STATES.IDLE;
    return state;
  }

  if (state === DRAFT_STATES.CONFIRMATION) {
    if (event?.type === "CONFIRM") return DRAFT_STATES.IDLE;
    if (event?.type === "EDIT") return DRAFT_STATES.PARSED;
    if (event?.type === "CANCEL") return DRAFT_STATES.IDLE;
  }

  return state;
}

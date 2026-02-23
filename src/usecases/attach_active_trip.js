export function attachActiveTripToDraft(draft, activeTrip) {
  if (!draft) return draft;

  const previousActiveTripId = draft.active_trip_id || null;
  const previousTripId = draft.trip_id || null;

  if (!activeTrip?.tripId) {
    return {
      ...draft,
      active_trip_id: null,
      trip_name: draft.trip_name ?? null
    };
  }

  const next = {
    ...draft,
    active_trip_id: String(activeTrip.tripId),
    trip_name: activeTrip.tripName || draft.trip_name || null
  };

  const explicitlyExcludedTrip =
    previousTripId === null && previousActiveTripId && previousActiveTripId === activeTrip.tripId;

  if (explicitlyExcludedTrip) {
    next.base_currency = "MXN";
    if (!next.currency_explicit) {
      next.currency = "MXN";
    }
  }

  const shouldAssignTrip = !next.trip_id && !explicitlyExcludedTrip;
  if (shouldAssignTrip) {
    next.trip_id = String(activeTrip.tripId);
  }

  const shouldApplyTripCurrency = Boolean(next.trip_id) && !explicitlyExcludedTrip;
  if (shouldApplyTripCurrency && activeTrip.baseCurrency) {
    next.base_currency = String(activeTrip.baseCurrency).toUpperCase();
  } else if (!next.base_currency) {
    next.base_currency = "MXN";
  }

  if (
    shouldApplyTripCurrency &&
    (!next.currency || next.currency === "MXN") &&
    !next.currency_explicit &&
    activeTrip.baseCurrency
  ) {
    next.currency = String(activeTrip.baseCurrency).toUpperCase();
  }

  return next;
}

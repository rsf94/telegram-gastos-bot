import { getActiveTripCache, setActiveTripCache } from "../cache/active_trip_cache.js";
import { getActiveTripId, getTripById } from "../storage/bigquery.js";

function shortError(error) {
  const msg = error?.message || String(error || "");
  return msg.split("\n")[0].slice(0, 180);
}

function shouldLogDevTripResolution() {
  const env = String(process.env.NODE_ENV || "").toLowerCase();
  return env === "development" || env === "dev" || env === "test";
}

function logTripResolution(logger, payload) {
  if (!shouldLogDevTripResolution()) return;
  logger.info?.(JSON.stringify({ type: "active_trip_resolution", ...payload }));
}

export async function getActiveTripForChat(
  chatId,
  {
    getActiveTripCacheFn = getActiveTripCache,
    setActiveTripCacheFn = setActiveTripCache,
    getActiveTripIdFn = getActiveTripId,
    getTripByIdFn = getTripById,
    logger = console
  } = {}
) {
  const cached = getActiveTripCacheFn(chatId);
  if (cached) {
    logTripResolution(logger, {
      chat_id: String(chatId),
      cache_hit: true,
      queried_bigquery: false,
      active_trip_id: cached.tripId || null
    });
    return cached;
  }

  logTripResolution(logger, {
    chat_id: String(chatId),
    cache_hit: false,
    queried_bigquery: true,
    active_trip_id: null
  });

  try {
    const tripId = await getActiveTripIdFn(chatId);
    if (!tripId) {
      setActiveTripCacheFn(chatId, { tripId: null, tripName: null, baseCurrency: null });
      logTripResolution(logger, {
        chat_id: String(chatId),
        cache_hit: false,
        queried_bigquery: true,
        active_trip_id: null
      });
      return null;
    }

    let tripName = null;
    let baseCurrency = null;
    try {
      const trip = await getTripByIdFn(chatId, tripId);
      tripName = trip?.name || null;
      baseCurrency = trip?.base_currency || null;
    } catch (error) {
      logger.warn?.(
        JSON.stringify({
          type: "active_trip_lookup_warn",
          chat_id: String(chatId),
          trip_id: String(tripId),
          msg: shortError(error)
        })
      );
    }

    const resolved = {
      tripId: String(tripId),
      tripName,
      baseCurrency: baseCurrency ? String(baseCurrency).toUpperCase() : null
    };

    setActiveTripCacheFn(chatId, resolved);
    logTripResolution(logger, {
      chat_id: String(chatId),
      cache_hit: false,
      queried_bigquery: true,
      active_trip_id: resolved.tripId
    });
    return resolved;
  } catch (error) {
    logger.warn?.(
      JSON.stringify({
        type: "active_trip_resolve_error",
        chat_id: String(chatId),
        msg: shortError(error)
      })
    );
    return null;
  }
}

export async function resolveActiveTripForChat(chatId, deps = {}) {
  const activeTrip = await getActiveTripForChat(chatId, deps);
  if (!activeTrip) return null;
  return {
    trip_id: activeTrip.tripId,
    trip_name: activeTrip.tripName
  };
}

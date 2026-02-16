import { getActiveTripId, getTripById } from "../storage/bigquery.js";

function shortError(error) {
  const msg = error?.message || String(error || "");
  return msg.split("\n")[0].slice(0, 180);
}

export async function resolveActiveTripForChat(
  chatId,
  {
    getActiveTripIdFn = getActiveTripId,
    getTripByIdFn = getTripById,
    logger = console
  } = {}
) {
  try {
    const tripId = await getActiveTripIdFn(chatId);
    if (!tripId) return null;

    let tripName = null;
    try {
      const trip = await getTripByIdFn(chatId, tripId);
      tripName = trip?.name || null;
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

    return {
      trip_id: String(tripId),
      trip_name: tripName
    };
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

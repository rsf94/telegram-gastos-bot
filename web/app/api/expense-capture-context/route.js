import { NextResponse } from "next/server";
import { assertAuthenticated, readSession } from "../../../lib/session.js";

export const dynamic = "force-dynamic";

const defaultMethods = [{ id: "cash", label: "Efectivo" }];

export async function GET(request) {
  const session = await readSession(request);
  if (!assertAuthenticated(session)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    methods: defaultMethods,
    hasTrip: false,
    activeTripId: null
  });
}

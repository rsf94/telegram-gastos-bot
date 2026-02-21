import { NextResponse } from "next/server";
import { assertAuthenticated, readSession } from "../../../lib/session.js";

export const dynamic = "force-dynamic";

export async function POST(request) {
  const session = await readSession(request);
  if (!assertAuthenticated(session)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await request.json();

  return NextResponse.json({ ok: true, status: "guardado" });
}

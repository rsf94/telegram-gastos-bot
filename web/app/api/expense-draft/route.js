import { NextResponse } from "next/server";
import { assertAuthenticated, readSession } from "../../../lib/session.js";

export const dynamic = "force-dynamic";

export async function POST(request) {
  const session = await readSession(request);
  if (!assertAuthenticated(session)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const text = String(body?.text || "").trim();
  const amountMatch = text.match(/(\d+(?:\.\d+)?)/);
  const amount = amountMatch ? Number(amountMatch[1]) : 0;
  const description = text.replace(/\d+(?:\.\d+)?/, "").trim() || "Gasto";

  return NextResponse.json({
    ok: true,
    draft: {
      amount,
      description,
      rawText: text
    }
  });
}

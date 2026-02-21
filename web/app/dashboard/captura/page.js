import { headers } from "next/headers";
import CapturaClient from "./CapturaClient";
import { assertAuthenticated, readSession } from "../../../lib/session.js";

export const dynamic = "force-dynamic";

export default async function CapturaPage() {
  const requestHeaders = headers();
  const session = await readSession({ headers: requestHeaders }, process.env);

  if (!assertAuthenticated(session)) {
    return <main className="p-6">Unauthorized</main>;
  }

  return <CapturaClient />;
}

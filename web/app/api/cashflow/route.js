import { BigQuery } from "@google-cloud/bigquery";
import { handleCashflowRequest } from "../../../lib/cashflow_api.js";

export const dynamic = "force-dynamic";

const bq = new BigQuery({
  projectId: process.env.BQ_PROJECT_ID || undefined
});

export async function GET(request) {
  return handleCashflowRequest({ request, bq, env: process.env });
}

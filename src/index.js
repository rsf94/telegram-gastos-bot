import express from "express";

import { warnMissingEnv } from "./config.js";
import { runDailyCardReminders } from "./reminders.js";
import { createCallbackHandler } from "./handlers/callbacks.js";
import { createMessageHandler } from "./handlers/messages.js";
import { createAnalysisHandler } from "./handlers/analysis.js";
import {
  getDueEnrichmentRetries,
  getExpenseById,
  insertEnrichmentRetryEvent,
  updateExpenseEnrichment
} from "./storage/bigquery.js";
import { processEnrichmentRetryQueue } from "./usecases/enrichment_retry.js";

warnMissingEnv();

const app = express();
app.use(express.json({ limit: "1mb" }));

const analysisHandler = createAnalysisHandler();
const handleCallback = createCallbackHandler({
  handleAnalysisCallback: analysisHandler.handleAnalysisCallback
});
const handleMessage = createMessageHandler({
  handleAnalysisCommand: analysisHandler.handleAnalysisCommand
});

/* =======================
 * Routes
 * ======================= */
app.get("/", (req, res) => res.status(200).send("OK"));

app.post("/telegram-webhook", async (req, res) => {
  res.status(200).send("ok");

  try {
    const update = req.body;
    const cb = update.callback_query;
    if (cb?.message?.chat?.id) {
      await handleCallback(cb);
      return;
    }

    const msg = update.message || update.edited_message;
    if (msg?.chat?.id) {
      await handleMessage(msg);
    }
  } catch (e) {
    console.error(e);
  }
});

// ===== CRON: recordatorios (corte/pago) =====
app.get("/cron/daily", async (req, res) => {
  try {
    const token = String(req.query.token || "");
    if (!process.env.CRON_TOKEN || token !== process.env.CRON_TOKEN) {
      return res.status(401).send("unauthorized");
    }

    const force = String(req.query.force || "") === "1";
    await runDailyCardReminders({ force });

    return res.status(200).send("ok");
  } catch (e) {
    console.error(e);
    return res.status(500).send("error");
  }
});

// ===== CRON: enrichment retry =====
app.get("/cron/enrich", async (req, res) => {
  const startedAt = Date.now();
  let summary = null;
  let errorShort = null;
  try {
    const token = String(req.query.token || "");
    if (!process.env.CRON_TOKEN || token !== process.env.CRON_TOKEN) {
      return res.status(401).send("unauthorized");
    }

    const limit = Number(req.query.limit || 50);
    summary = await processEnrichmentRetryQueue({
      limit,
      getDueEnrichmentRetryTasksFn: getDueEnrichmentRetries,
      getExpenseByIdFn: getExpenseById,
      updateExpenseEnrichmentFn: updateExpenseEnrichment,
      insertEnrichmentRetryEventFn: insertEnrichmentRetryEvent
    });
  } catch (e) {
    console.error(e);
    errorShort = String(e?.message || e || "").split("\n")[0].slice(0, 180);
    if (!summary) {
      summary = {
        processed: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        llmMs: 0,
        bqMs: 0,
        llmProviders: []
      };
    }
  } finally {
    const totalMs = Date.now() - startedAt;
    const providers = summary?.llmProviders || [];
    const llmProvider =
      providers.length === 0 ? "unknown" : providers.length === 1 ? providers[0] : "mixed";
    const payload = {
      type: "cron_enrich",
      processed: summary?.processed || 0,
      succeeded: summary?.succeeded || 0,
      failed: summary?.failed || 0,
      skipped: summary?.skipped || 0,
      llm_provider: llmProvider,
      llm_ms: summary?.llmMs || 0,
      bq_ms: summary?.bqMs || 0,
      total_ms: totalMs,
      error: errorShort || undefined
    };
    console.log(JSON.stringify(payload));
  }

  return res.status(200).json({
    ok: true,
    processed: summary?.processed || 0,
    succeeded: summary?.succeeded || 0,
    failed: summary?.failed || 0,
    skipped: summary?.skipped || 0
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`listening on ${PORT}`));

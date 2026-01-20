import express from "express";

import { warnMissingEnv } from "./config.js";
import { runDailyCardReminders } from "./reminders.js";
import { createCallbackHandler } from "./handlers/callbacks.js";
import { createMessageHandler } from "./handlers/messages.js";
import {
  deleteEnrichmentRetryTask,
  getDueEnrichmentRetries,
  updateEnrichmentRetryTask,
  updateExpenseEnrichment
} from "./storage/bigquery.js";
import { processEnrichmentRetryQueue } from "./usecases/enrichment_retry.js";

warnMissingEnv();

const app = express();
app.use(express.json({ limit: "1mb" }));

const handleCallback = createCallbackHandler();
const handleMessage = createMessageHandler();

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
  try {
    const token = String(req.query.token || "");
    if (!process.env.CRON_TOKEN || token !== process.env.CRON_TOKEN) {
      return res.status(401).send("unauthorized");
    }

    const limit = Number(req.query.limit || 50);
    await processEnrichmentRetryQueue({
      limit,
      getDueEnrichmentRetryTasksFn: getDueEnrichmentRetries,
      updateExpenseEnrichmentFn: updateExpenseEnrichment,
      updateEnrichmentRetryTaskFn: updateEnrichmentRetryTask,
      deleteEnrichmentRetryTaskFn: deleteEnrichmentRetryTask
    });

    return res.status(200).send("ok");
  } catch (e) {
    console.error(e);
    return res.status(500).send("error");
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`listening on ${PORT}`));

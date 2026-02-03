import express from "express";
import crypto from "crypto";

import { validateEnv, warnMissingEnv } from "./config.js";
import { runDailyCardReminders, runPaymentDateReminders } from "./reminders.js";
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

validateEnv();
warnMissingEnv();

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  const incoming = String(req.get("x-request-id") || "").trim();
  const requestId = incoming || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);
  next();
});

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

function logPerf(payload, level = "log") {
  const base = { type: "perf", ...payload };
  if (level === "warn") {
    console.warn(JSON.stringify(base));
  } else {
    console.log(JSON.stringify(base));
  }
}

function shortError(error) {
  const msg = error?.message || String(error || "");
  return msg.split("\n")[0].slice(0, 180);
}

app.post("/telegram-webhook", async (req, res) => {
  res.status(200).send("ok");

  const startedAt = Date.now();
  const requestId = req.requestId;
  let chatId = null;
  let option = "unknown";
  let status = "ok";
  let errorShort = null;

  try {
    const update = req.body;
    const cb = update.callback_query;
    if (cb?.message?.chat?.id) {
      chatId = String(cb.message.chat.id);
      option = "callback";
      await handleCallback(cb, { requestId });
      return;
    }

    const msg = update.message || update.edited_message;
    if (msg?.chat?.id) {
      chatId = String(msg.chat.id);
      option = "message";
      await handleMessage(msg, { requestId });
    }
  } catch (e) {
    status = "error";
    errorShort = shortError(e);
    console.error(e);
  } finally {
    const totalMs = Date.now() - startedAt;
    logPerf(
      {
        request_id: requestId,
        flow: "telegram_webhook",
        option,
        chat_id: chatId,
        bq_ms: 0,
        llm_ms: 0,
        total_ms: totalMs,
        status,
        error: errorShort || undefined
      },
      status === "error" ? "warn" : "log"
    );
  }
});

// ===== CRON: recordatorios (corte/pago) =====
app.get("/cron/daily", async (req, res) => {
  const startedAt = Date.now();
  const requestId = req.requestId;
  let status = "ok";
  let errorShort = null;
  let bqMs = 0;
  try {
    const token = String(req.query.token || "");
    if (!process.env.CRON_TOKEN || token !== process.env.CRON_TOKEN) {
      status = "error";
      errorShort = "unauthorized";
      return res.status(401).send("unauthorized");
    }

    const force = String(req.query.force || "") === "1";
    const result = await runDailyCardReminders({ force, requestId });
    bqMs = Number(result?.bqMs || 0);

    return res.status(200).send("ok");
  } catch (e) {
    status = "error";
    errorShort = shortError(e);
    console.error(e);
    return res.status(500).send("error");
  } finally {
    const totalMs = Date.now() - startedAt;
    logPerf(
      {
        request_id: requestId,
        flow: "cron:daily",
        option: "RUN",
        chat_id: null,
        bq_ms: bqMs,
        llm_ms: 0,
        total_ms: totalMs,
        status,
        error: errorShort || undefined
      },
      status === "error" ? "warn" : "log"
    );
  }
});

// ===== CRON: recordatorios de pago =====
app.get("/cron/payment-reminders", async (req, res) => {
  const startedAt = Date.now();
  const requestId = req.requestId;
  let status = "ok";
  let errorShort = null;
  let summary = null;
  try {
    const token = String(req.query.token || "");
    if (!process.env.CRON_TOKEN || token !== process.env.CRON_TOKEN) {
      status = "error";
      errorShort = "unauthorized";
      return res.status(401).send("unauthorized");
    }

    const limitChats = Number(req.query.limitChats || 50);
    summary = await runPaymentDateReminders({ limitChats, requestId });
  } catch (e) {
    status = "error";
    errorShort = shortError(e);
    console.error(e);
    if (!summary) {
      summary = {
        ok: false,
        scanned_cards: 0,
        due_tomorrow: 0,
        sent: 0,
        skipped: 0,
        bq_ms: 0,
        total_ms: 0
      };
    }
  } finally {
    const totalMs = Date.now() - startedAt;
    logPerf(
      {
        request_id: requestId,
        flow: "cron:payment_reminders",
        option: "RUN",
        chat_id: null,
        bq_ms: summary?.bq_ms || 0,
        llm_ms: 0,
        total_ms: totalMs,
        status,
        error: errorShort || undefined
      },
      status === "error" ? "warn" : "log"
    );
  }

  return res.status(200).json({
    ok: summary?.ok === true,
    scanned_cards: summary?.scanned_cards || 0,
    due_tomorrow: summary?.due_tomorrow || 0,
    sent: summary?.sent || 0,
    skipped: summary?.skipped || 0,
    bq_ms: summary?.bq_ms || 0,
    total_ms: summary?.total_ms || 0
  });
});

// ===== CRON: enrichment retry =====
app.get("/cron/enrich", async (req, res) => {
  const startedAt = Date.now();
  const requestId = req.requestId;
  let summary = null;
  let errorShort = null;
  let limit = 50;
  let totalMs = 0;
  let status = "ok";
  try {
    const token = String(req.query.token || "");
    if (!process.env.CRON_TOKEN || token !== process.env.CRON_TOKEN) {
      status = "error";
      errorShort = "unauthorized";
      return res.status(401).send("unauthorized");
    }

    limit = Number(req.query.limit || 50);
    summary = await processEnrichmentRetryQueue({
      limit,
      getDueEnrichmentRetryTasksFn: getDueEnrichmentRetries,
      getExpenseByIdFn: getExpenseById,
      updateExpenseEnrichmentFn: updateExpenseEnrichment,
      insertEnrichmentRetryEventFn: insertEnrichmentRetryEvent
    });
  } catch (e) {
    console.error(e);
    status = "error";
    errorShort = String(e?.message || e || "").split("\n")[0].slice(0, 180);
    if (!summary) {
      summary = {
        claimed: 0,
        processed: 0,
        done: 0,
        failed: 0,
        skipped_not_due: 0,
        skipped_noop: 0,
        llmMs: 0,
        bqMs: 0,
        llmProviders: []
      };
    }
  } finally {
    totalMs = Date.now() - startedAt;
    const providers = summary?.llmProviders || [];
    const llmProvider =
      providers.length === 0 ? "none" : providers.length === 1 ? providers[0] : "mixed";
    const payload = {
      type: "perf",
      request_id: requestId,
      flow: "cron:enrich",
      option: "RUN",
      chat_id: null,
      limit,
      claimed: summary?.claimed || 0,
      processed: summary?.processed || 0,
      done: summary?.done || 0,
      failed: summary?.failed || 0,
      skipped_not_due: summary?.skipped_not_due || 0,
      skipped_noop: summary?.skipped_noop || 0,
      provider: llmProvider,
      llm_ms: summary?.llmMs || 0,
      bq_ms: summary?.bqMs || 0,
      total_ms: totalMs,
      status,
      error: errorShort || undefined
    };
    if (status === "error") {
      console.warn(JSON.stringify(payload));
    } else {
      console.log(JSON.stringify(payload));
    }
  }

  return res.status(200).json({
    ok: true,
    limit,
    claimed: summary?.claimed || 0,
    processed: summary?.processed || 0,
    done: summary?.done || 0,
    failed: summary?.failed || 0,
    skipped_not_due: summary?.skipped_not_due || 0,
    skipped_noop: summary?.skipped_noop || 0,
    llm_ms: summary?.llmMs || 0,
    bq_ms: summary?.bqMs || 0,
    total_ms: totalMs,
    provider:
      summary?.llmProviders?.length === 0
        ? "none"
        : summary?.llmProviders?.length === 1
          ? summary.llmProviders[0]
          : "mixed"
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`listening on ${PORT}`));

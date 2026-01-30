import {
  answerCallbackQuery,
  escapeHtml,
  tgEditMessage,
  tgSend
} from "../telegram.js";
import { todayISOInTZ, APP_TZ } from "../parsing.js";
import { getActiveCardRules } from "../cache/card_rules_cache.js";
import {
  getAnalysisCategoryDelta,
  getAnalysisCategoryTotals,
  getAnalysisMsiTotalsByCard,
  getAnalysisNoMsiTotalsByCardRanges,
  getAnalysisPendingMsiByCard,
  getAnalysisPendingMsiByMonth,
  getAnalysisPendingMsiTotal
} from "../storage/bigquery.js";
import {
  addDaysISO,
  addMonthsISO,
  cutISOForYM,
  prevYM,
  resolveStatementForPayMonth,
  startOfMonthISO,
  statementMonthISO,
  ymFromISO
} from "../analysis/date_utils.js";

const ANALYSIS_PREFIX = "ANALYSIS:";

function analysisMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "Gasto del mes (total y por categoría)",
          callback_data: `${ANALYSIS_PREFIX}MONTH_SUMMARY`
        }
      ],
      [
        {
          text: "Qué pago en: Este mes / Próximo mes / Elegir mes",
          callback_data: `${ANALYSIS_PREFIX}PAY_MENU`
        }
      ],
      [
        {
          text: "Total pendiente MSI",
          callback_data: `${ANALYSIS_PREFIX}MSI_PENDING`
        }
      ],
      [
        {
          text: "Categorías donde más subí (vs mes anterior)",
          callback_data: `${ANALYSIS_PREFIX}CATEGORY_DELTA`
        }
      ]
    ]
  };
}

function analysisPayMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "Este mes", callback_data: `${ANALYSIS_PREFIX}PAY_THIS_MONTH` },
        { text: "Próximo mes", callback_data: `${ANALYSIS_PREFIX}PAY_NEXT_MONTH` }
      ],
      [{ text: "Elegir mes", callback_data: `${ANALYSIS_PREFIX}PAY_PICKER` }],
      [{ text: "⬅️ Volver", callback_data: `${ANALYSIS_PREFIX}BACK_MENU` }]
    ]
  };
}

function normalizeBillingMonth(iso) {
  if (!iso) return iso;
  if (typeof iso === "object" && "value" in iso) {
    return iso.value;
  }
  return iso;
}

function monthLabel(iso, format = "long") {
  const normalized = normalizeBillingMonth(iso);
  if (normalized == null) return "Mes desconocido";
  const rawValue = typeof normalized === "string" ? normalized.trim() : normalized;
  if (rawValue === "") return "Mes desconocido";
  const date =
    rawValue instanceof Date ? rawValue : new Date(`${String(rawValue)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return "Mes desconocido";
  return new Intl.DateTimeFormat("es-MX", {
    timeZone: APP_TZ,
    month: format,
    year: "numeric"
  }).format(date);
}

function monthPickerKeyboard(baseMonthISO) {
  const offsets = Array.from({ length: 13 }, (_, i) => i - 6);
  const rows = [];
  let row = [];
  for (const offset of offsets) {
    const monthISO = addMonthsISO(baseMonthISO, offset);
    const label = monthLabel(monthISO, "short");
    row.push({
      text: label,
      callback_data: `${ANALYSIS_PREFIX}PAY_MONTH:${monthISO}`
    });
    if (row.length === 3) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);
  rows.push([{ text: "⬅️ Volver", callback_data: `${ANALYSIS_PREFIX}PAY_MENU` }]);
  return { inline_keyboard: rows };
}

function formatMoneyMXN(n) {
  const x = Number(n || 0);
  return x.toLocaleString("es-MX", {
    style: "currency",
    currency: "MXN",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatPercent(amount, total) {
  if (!total) return "0%";
  const pct = (Number(amount || 0) / Number(total)) * 100;
  return `${pct.toFixed(1)}%`;
}

function logPerf(payload, level = "log") {
  const base = { type: "perf", ...payload };
  if (level === "warn") {
    console.warn(JSON.stringify(base));
  } else {
    console.log(JSON.stringify(base));
  }
}

function parseAnalysisMonth(data) {
  const parts = data.split(":");
  if (parts.length >= 3) {
    return parts.slice(2).join(":");
  }
  return null;
}

export function createAnalysisHandler({
  sendMessage = tgSend,
  editMessage = tgEditMessage,
  answerCallback = answerCallbackQuery,
  getActiveCardRulesFn = getActiveCardRules,
  getAnalysisCategoryTotalsFn = getAnalysisCategoryTotals,
  getAnalysisNoMsiTotalsByCardRangesFn = getAnalysisNoMsiTotalsByCardRanges,
  getAnalysisMsiTotalsByCardFn = getAnalysisMsiTotalsByCard,
  getAnalysisPendingMsiTotalFn = getAnalysisPendingMsiTotal,
  getAnalysisPendingMsiByCardFn = getAnalysisPendingMsiByCard,
  getAnalysisPendingMsiByMonthFn = getAnalysisPendingMsiByMonth,
  getAnalysisCategoryDeltaFn = getAnalysisCategoryDelta
} = {}) {
  async function sendMenu(chatId) {
    const msg = [
      "📊 <b>Modo análisis</b>",
      "Elige una opción:"
    ].join("\n");
    await sendMessage(chatId, msg, { reply_markup: analysisMenuKeyboard() });
  }

  async function showMenuFromCallback(cb) {
    const chatId = String(cb.message.chat.id);
    const messageId = cb.message?.message_id;
    const msg = [
      "📊 <b>Modo análisis</b>",
      "Elige una opción:"
    ].join("\n");
    if (messageId) {
      await editMessage(chatId, messageId, msg, { reply_markup: analysisMenuKeyboard() });
    } else {
      await sendMessage(chatId, msg, { reply_markup: analysisMenuKeyboard() });
    }
  }

  async function showPayMenu(cb) {
    const chatId = String(cb.message.chat.id);
    const messageId = cb.message?.message_id;
    const msg = ["💳 <b>Qué pago en</b>", "Elige un mes:"].join("\n");
    if (messageId) {
      await editMessage(chatId, messageId, msg, { reply_markup: analysisPayMenuKeyboard() });
    } else {
      await sendMessage(chatId, msg, { reply_markup: analysisPayMenuKeyboard() });
    }
  }

  async function showMonthPicker(cb) {
    const chatId = String(cb.message.chat.id);
    const messageId = cb.message?.message_id;
    const baseMonthISO = startOfMonthISO(todayISOInTZ());
    const msg = "🗓️ <b>Elige un mes</b>";
    if (messageId) {
      await editMessage(chatId, messageId, msg, {
        reply_markup: monthPickerKeyboard(baseMonthISO)
      });
    } else {
      await sendMessage(chatId, msg, { reply_markup: monthPickerKeyboard(baseMonthISO) });
    }
  }

  async function handleMonthSummary(chatId, requestId) {
    const startedAt = Date.now();
    let bqMs = 0;
    const monthISO = startOfMonthISO(todayISOInTZ());

    const queryStart = Date.now();
    const rows = await getAnalysisCategoryTotalsFn({ chatId, monthISO });
    bqMs += Date.now() - queryStart;

    const totals = rows.map((row) => ({
      category: row.category || "Other",
      total: Number(row.total || 0)
    }));
    const totalSum = totals.reduce((acc, row) => acc + row.total, 0);

    const top = totals.slice(0, 6);
    const others = totals.slice(6).reduce((acc, row) => acc + row.total, 0);

    const lines = [
      `📊 <b>Gasto del mes (${escapeHtml(monthLabel(monthISO))})</b>`,
      `Total: <b>${escapeHtml(formatMoneyMXN(totalSum))}</b>`,
      "",
      "<b>Categorías:</b>"
    ];

    for (const row of top) {
      lines.push(
        `• ${escapeHtml(row.category)}: <b>${escapeHtml(
          formatMoneyMXN(row.total)
        )}</b> (${formatPercent(row.total, totalSum)})`
      );
    }
    if (others > 0) {
      lines.push(
        `• Otros: <b>${escapeHtml(formatMoneyMXN(others))}</b> (${formatPercent(
          others,
          totalSum
        )})`
      );
    }

    await sendMessage(chatId, lines.join("\n"));

    const totalMs = Date.now() - startedAt;
    logPerf({
      request_id: requestId || null,
      flow: "analysis:month_summary",
      bq_ms: bqMs,
      llm_ms: 0,
      total_ms: totalMs,
      chat_id: chatId,
      option: "MONTH_SUMMARY",
      status: "ok"
    });
  }

  async function handlePayMonth(chatId, monthISO, requestId) {
    const startedAt = Date.now();
    let bqMs = 0;

    const rulesStart = Date.now();
    const rules = await getActiveCardRulesFn(chatId);
    bqMs += Date.now() - rulesStart;

    if (!rules.length) {
      await sendMessage(chatId, "No encontré tarjetas activas para este chat.");
      return;
    }

    const cardSummaries = rules.map((rule) => {
      const target = resolveStatementForPayMonth({
        payMonthISO: monthISO,
        cutDay: Number(rule.cut_day),
        payOffsetDays: Number(rule.pay_offset_days || 0),
        rollWeekendToMonday: Boolean(rule.roll_weekend_to_monday)
      });

      const { y: cy, m: cm } = { y: target.cutYear, m: target.cutMonth };
      const { y: py, m: pm } = prevYM(cy, cm);
      const prevCutISO = cutISOForYM(py, pm, Number(rule.cut_day));
      const cycleStart = addDaysISO(prevCutISO, 1);
      const cycleEnd = target.cutISO;
      const statementMonth = statementMonthISO(target.cutISO);

      return {
        card_name: String(rule.card_name),
        cutISO: target.cutISO,
        payISO: target.payISO,
        cycleStart,
        cycleEnd,
        statementMonth
      };
    });

    const ranges = cardSummaries.map((summary) => ({
      card_name: summary.card_name,
      start_date: summary.cycleStart,
      end_date: summary.cycleEnd
    }));

    const noMsiStart = Date.now();
    const noMsiRows = await getAnalysisNoMsiTotalsByCardRangesFn({
      chatId,
      ranges
    });
    bqMs += Date.now() - noMsiStart;

    const noMsiMap = new Map(
      noMsiRows.map((row) => [String(row.card_name), Number(row.total || 0)])
    );

    const msiMap = new Map();
    const statementsByMonth = new Map();
    for (const summary of cardSummaries) {
      const monthKey = summary.statementMonth;
      if (!statementsByMonth.has(monthKey)) {
        statementsByMonth.set(monthKey, []);
      }
      statementsByMonth.get(monthKey).push(summary.card_name);
    }

    for (const [statementMonth, cardNames] of statementsByMonth.entries()) {
      const msiStart = Date.now();
      const rows = await getAnalysisMsiTotalsByCardFn({
        chatId,
        cardNames,
        monthISO: statementMonth
      });
      bqMs += Date.now() - msiStart;

      for (const row of rows) {
        msiMap.set(String(row.card_name), Number(row.total || 0));
      }
    }

    let totalGeneral = 0;
    const lines = [
      `💳 <b>Pagos en ${escapeHtml(monthLabel(monthISO))}</b>`,
      ""
    ];

    for (const summary of cardSummaries) {
      const noMsi = noMsiMap.get(summary.card_name) || 0;
      const msi = msiMap.get(summary.card_name) || 0;
      const total = noMsi + msi;
      totalGeneral += total;

      lines.push(
        `• <b>${escapeHtml(summary.card_name)}</b> (corte <code>${escapeHtml(
          summary.cutISO
        )}</code>, pago <code>${escapeHtml(summary.payISO)}</code>)`
      );
      lines.push(
        `  - No MSI: <b>${escapeHtml(formatMoneyMXN(noMsi))}</b>`,
        `  - MSI: <b>${escapeHtml(formatMoneyMXN(msi))}</b>`,
        `  - Total: <b>${escapeHtml(formatMoneyMXN(total))}</b>`
      );
    }

    lines.splice(1, 0, `Total estimado: <b>${escapeHtml(formatMoneyMXN(totalGeneral))}</b>`);

    await sendMessage(chatId, lines.join("\n"));

    const totalMs = Date.now() - startedAt;
    logPerf({
      request_id: requestId || null,
      flow: "analysis:pay_month",
      bq_ms: bqMs,
      llm_ms: 0,
      total_ms: totalMs,
      chat_id: chatId,
      option: "PAY_MONTH",
      status: "ok"
    });
  }

  async function handlePendingMsi(chatId, requestId) {
    const startedAt = Date.now();
    let bqMs = 0;
    const startMonthISO = startOfMonthISO(todayISOInTZ());

    const totalStart = Date.now();
    const total = await getAnalysisPendingMsiTotalFn({ chatId });
    bqMs += Date.now() - totalStart;

    const cardStart = Date.now();
    const byCard = await getAnalysisPendingMsiByCardFn({ chatId, limit: 6 });
    bqMs += Date.now() - cardStart;

    const monthStart = Date.now();
    const byMonth = await getAnalysisPendingMsiByMonthFn({
      chatId,
      startMonthISO,
      limit: 6
    });
    bqMs += Date.now() - monthStart;

    const lines = [
      "🧾 <b>Total pendiente MSI</b>",
      `Total: <b>${escapeHtml(formatMoneyMXN(total))}</b>`,
      "",
      "<b>Por tarjeta:</b>"
    ];

    if (!byCard.length) {
      lines.push("• Sin MSI pendientes.");
    } else {
      for (const row of byCard) {
        lines.push(
          `• ${escapeHtml(row.card_name)}: <b>${escapeHtml(
            formatMoneyMXN(row.total)
          )}</b>`
        );
      }
    }

    lines.push("", "<b>Próximos meses:</b>");
    if (!byMonth.length) {
      lines.push("• Sin MSI pendientes.");
    } else {
      for (const row of byMonth) {
        const monthValue = normalizeBillingMonth(row.billing_month);
        const label = monthLabel(monthValue);
        lines.push(
          `• ${escapeHtml(label)}: <b>${escapeHtml(formatMoneyMXN(row.total))}</b>`
        );
      }
    }

    await sendMessage(chatId, lines.join("\n"));

    const totalMs = Date.now() - startedAt;
    logPerf({
      request_id: requestId || null,
      flow: "analysis:msi_pending",
      bq_ms: bqMs,
      llm_ms: 0,
      total_ms: totalMs,
      chat_id: chatId,
      option: "MSI_PENDING",
      status: "ok"
    });
  }

  async function handleCategoryDelta(chatId, requestId) {
    const startedAt = Date.now();
    let bqMs = 0;
    const monthISO = startOfMonthISO(todayISOInTZ());
    const { y: cy, m: cm } = ymFromISO(monthISO);
    const { y: py, m: pm } = prevYM(cy, cm);
    const prevMonthISO = `${py}-${String(pm).padStart(2, "0")}-01`;

    const queryStart = Date.now();
    const rows = await getAnalysisCategoryDeltaFn({ chatId, monthISO });
    bqMs += Date.now() - queryStart;

    const deltas = rows.map((row) => {
      const current = Number(row.current_total || 0);
      const prev = Number(row.prev_total || 0);
      return {
        category: row.category || "Other",
        current,
        prev,
        delta: current - prev
      };
    });

    const positives = deltas
      .filter((row) => row.delta > 0)
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 6);
    const negatives = deltas
      .filter((row) => row.delta < 0)
      .sort((a, b) => a.delta - b.delta)
      .slice(0, 3);

    const lines = [
      "📈 <b>Categorías donde más subí</b>",
      `Mes actual: <b>${escapeHtml(monthLabel(monthISO))}</b>`,
      `Mes anterior: <b>${escapeHtml(monthLabel(prevMonthISO))}</b>`,
      "",
      "<b>Alzas:</b>"
    ];

    if (!positives.length) {
      lines.push("• Sin alzas relevantes.");
    } else {
      for (const row of positives) {
        lines.push(
          `• ${escapeHtml(row.category)}: <b>+${escapeHtml(
            formatMoneyMXN(row.delta)
          )}</b> (de ${escapeHtml(formatMoneyMXN(row.prev))} a ${escapeHtml(
            formatMoneyMXN(row.current)
          )})`
        );
      }
    }

    lines.push("", "<b>Bajas:</b>");
    if (!negatives.length) {
      lines.push("• Sin bajas relevantes.");
    } else {
      for (const row of negatives) {
        lines.push(
          `• ${escapeHtml(row.category)}: <b>${escapeHtml(
            formatMoneyMXN(row.delta)
          )}</b> (de ${escapeHtml(formatMoneyMXN(row.prev))} a ${escapeHtml(
            formatMoneyMXN(row.current)
          )})`
        );
      }
    }

    await sendMessage(chatId, lines.join("\n"));

    const totalMs = Date.now() - startedAt;
    logPerf({
      request_id: requestId || null,
      flow: "analysis:category_delta",
      bq_ms: bqMs,
      llm_ms: 0,
      total_ms: totalMs,
      chat_id: chatId,
      option: "CATEGORY_DELTA",
      status: "ok"
    });
  }

  async function handleAnalysisCommand({ chatId, requestId }) {
    logPerf({
      request_id: requestId || null,
      flow: "analysis:menu",
      option: "MENU",
      chat_id: chatId,
      bq_ms: 0,
      llm_ms: 0,
      total_ms: 0,
      status: "ok"
    });
    await sendMenu(chatId);
  }

  async function handleAnalysisCallback(cb, { requestId } = {}) {
    if (!cb?.data?.startsWith(ANALYSIS_PREFIX)) return false;

    const chatId = String(cb.message.chat.id);
    const data = cb.data;
    const startedAt = Date.now();

    try {
      if (data === `${ANALYSIS_PREFIX}MONTH_SUMMARY`) {
        await handleMonthSummary(chatId, requestId);
        await answerCallback(cb.id);
        return true;
      }

      if (data === `${ANALYSIS_PREFIX}PAY_MENU`) {
        await showPayMenu(cb);
        await answerCallback(cb.id);
        return true;
      }

      if (data === `${ANALYSIS_PREFIX}PAY_PICKER`) {
        await showMonthPicker(cb);
        await answerCallback(cb.id);
        return true;
      }

      if (data === `${ANALYSIS_PREFIX}PAY_THIS_MONTH`) {
        const monthISO = startOfMonthISO(todayISOInTZ());
        await handlePayMonth(chatId, monthISO, requestId);
        await answerCallback(cb.id);
        return true;
      }

      if (data === `${ANALYSIS_PREFIX}PAY_NEXT_MONTH`) {
        const monthISO = addMonthsISO(startOfMonthISO(todayISOInTZ()), 1);
        await handlePayMonth(chatId, monthISO, requestId);
        await answerCallback(cb.id);
        return true;
      }

      if (data?.startsWith(`${ANALYSIS_PREFIX}PAY_MONTH:`)) {
        const monthISO = parseAnalysisMonth(data);
        if (monthISO) {
          await handlePayMonth(chatId, monthISO, requestId);
        }
        await answerCallback(cb.id);
        return true;
      }

      if (data === `${ANALYSIS_PREFIX}MSI_PENDING`) {
        await handlePendingMsi(chatId, requestId);
        await answerCallback(cb.id);
        return true;
      }

      if (data === `${ANALYSIS_PREFIX}CATEGORY_DELTA`) {
        await handleCategoryDelta(chatId, requestId);
        await answerCallback(cb.id);
        return true;
      }

      if (data === `${ANALYSIS_PREFIX}BACK_MENU`) {
        await showMenuFromCallback(cb);
        await answerCallback(cb.id);
        return true;
      }
    } catch (error) {
      const totalMs = Date.now() - startedAt;
      logPerf(
        {
          request_id: requestId || null,
          flow: "analysis:error",
          option: "CALLBACK_ERROR",
          chat_id: chatId,
          bq_ms: 0,
          llm_ms: 0,
          total_ms: totalMs,
          status: "error",
          error: String(error?.message || error || "").split("\n")[0].slice(0, 180)
        },
        "warn"
      );
      console.error(error);
      await sendMessage(chatId, "Ocurrió un error al generar el análisis.");
      await answerCallback(cb.id);
      return true;
    }

    return false;
  }

  return {
    handleAnalysisCommand,
    handleAnalysisCallback
  };
}

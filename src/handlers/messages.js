import crypto from "crypto";

import { ALLOWED_PAYMENT_METHODS } from "../config.js";
import {
  tgSend,
  deleteConfirmKeyboard,
  paymentMethodKeyboard,
  escapeHtml,
  mainKeyboard
} from "../telegram.js";
import {
  localParseExpense,
  naiveParse,
  validateDraft,
  overrideRelativeDate,
  preview,
  guessCategory,
  guessMerchant,
  cleanTextForDescription,
  paymentMethodPreview
} from "../parsing.js";
import {
  getDraft,
  setDraft,
  clearDraft,
  clearAll,
  getPendingDelete,
  setPendingDelete,
  setLastExpenseId,
  setLedgerDraft
} from "../state.js";
import {
  getExpenseById,
  countInstallmentsForExpense,
  getActiveCardNames,
  getBillingMonthForPurchase,
  listAccounts,
  createAccount
} from "../storage/bigquery.js";
import { saveExpense } from "../usecases/save_expense.js";
import { helpText, welcomeText } from "../ui/copy.js";
import {
  allowedInstitutionsList,
  accountLabel,
  buildAccountSelectKeyboard,
  buildConfirmKeyboard,
  formatAccountsList,
  formatMovementPreview,
  getDefaultCashAccount,
  matchAccountsByQuery,
  parseAccountCommand,
  parseMovementCommand
} from "../ledger.js";

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function looksLikeMsiText(text) {
  const t = String(text || "").toLowerCase();
  // cubre: "msi", "a msi", "6msi", "6 msi", "meses sin intereses"
  return (
    /\bmsi\b/.test(t) ||
    /\bmeses?\s+sin\s+intereses?\b/.test(t) ||
    /\d+\s*msi\b/.test(t)
  );
}

function parseJustMonths(text) {
  // Acepta "6", "6 meses", "a 6", "6 msi"
  const t = String(text || "").toLowerCase().trim();
  const m = t.match(/(\d{1,2})/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 1 || n > 60) return null;
  return n;
}

function isValidUuid(value) {
  const s = String(value || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s
  );
}

function normalizeBqDate(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object" && typeof value.value === "string") {
    return value.value;
  }
  return String(value);
}

function formatDeletePreview(expense, installmentsCount) {
  const lines = [
    "🗑️ <b>Confirmar borrado</b>",
    `ID: <code>${escapeHtml(expense.id)}</code>`,
    `Monto: <b>${escapeHtml(expense.amount_mxn)}</b>`,
    `Método: <b>${escapeHtml(expense.payment_method)}</b>`,
    `Fecha: <b>${escapeHtml(normalizeBqDate(expense.purchase_date))}</b>`,
    `Categoría: <b>${escapeHtml(expense.category || "Other")}</b>`,
    `Descripción: <b>${escapeHtml(expense.description || "")}</b>`
  ];

  if (expense.is_msi) {
    lines.push(
      `MSI: <b>sí</b>`,
      `Meses: <b>${escapeHtml(expense.msi_months)}</b>`,
      `Total MSI: <b>${escapeHtml(expense.msi_total_amount)}</b>`
    );
  } else {
    lines.push("MSI: <b>no</b>");
  }

  if (installmentsCount > 0) {
    lines.push(`⚠️ Esto eliminará también ${installmentsCount} mensualidades`);
  }

  return lines.join("\n");
}

function logBigQueryError(e) {
  console.error("❌ Error al guardar en BigQuery:", e?.name, e?.message);
  try {
    console.error("BigQuery e.errors:", JSON.stringify(e?.errors, null, 2));
  } catch (_) {
    // ignore
  }
}

function shortError(error) {
  const msg = error?.message || String(error || "");
  return msg.split("\n")[0].slice(0, 180);
}

function logPerf(payload, level = "log") {
  const base = { type: "perf", ...payload };
  if (level === "warn") {
    console.warn(JSON.stringify(base));
  } else {
    console.log(JSON.stringify(base));
  }
}

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signLinkToken(payload, secret) {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const unsigned = `${header}.${body}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(unsigned)
    .digest("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${unsigned}.${signature}`;
}

function matchesCommand(text, command) {
  const trimmed = String(text || "").trim().toLowerCase();
  const pattern = new RegExp(`^/${command}(?:@\\S*)?$`, "i");
  return pattern.test(trimmed);
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/g, "");
}

function monthOffset(baseDate, delta) {
  const year = baseDate.getUTCFullYear();
  const month = baseDate.getUTCMonth() + delta;
  const date = new Date(Date.UTC(year, month, 1));
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

export function createMessageHandler({
  sendMessage = tgSend,
  deleteConfirmKeyboardFn = deleteConfirmKeyboard,
  paymentMethodKeyboardFn = paymentMethodKeyboard,
  mainKeyboardFn = mainKeyboard,
  saveExpenseFn = saveExpense,
  getExpenseByIdFn = getExpenseById,
  countInstallmentsForExpenseFn = countInstallmentsForExpense,
  getActiveCardNamesFn = getActiveCardNames,
  getBillingMonthForPurchaseFn = getBillingMonthForPurchase,
  listAccountsFn = listAccounts,
  createAccountFn = createAccount,
  handleAnalysisCommand
} = {}) {
  return async function handleMessage(msg, { requestId } = {}) {
    const startedAt = Date.now();
    let status = "ok";
    let errorShort = null;
    let option = "text";
    if (!msg?.chat?.id) return;

    const chatId = String(msg.chat.id);
    const text = (msg.text || "").trim();

    const low = text.toLowerCase();
    const logLedgerPerf = (payload, level = "log") => {
      logPerf(
        {
          request_id: requestId || null,
          flow: "ledger",
          chat_id: chatId,
          ...payload
        },
        level
      );
    };

    try {
      if (!text) {
        option = "empty";
        await sendMessage(chatId, welcomeText());
        return;
      }

      if (low === "ayuda" || low === "/help") {
        option = "command:help";
        await sendMessage(chatId, helpText());
        return;
      }

      if (["hola", "hi", "buenas", "hey", "menu", "/start"].includes(low)) {
        option = "command:start";
        await sendMessage(chatId, welcomeText());
        return;
      }

      if (low === "cancelar" || low === "/cancel") {
        option = "command:cancel";
        clearAll(chatId);
        await sendMessage(chatId, "🧹 <b>Cancelado</b>.");
        return;
      }

      if (matchesCommand(text, "link")) {
        option = "command:link";
        const baseUrl = normalizeBaseUrl(process.env.DASHBOARD_BASE_URL);
        const secret = process.env.LINK_TOKEN_SECRET;
        if (!baseUrl || !secret) {
          await sendMessage(
            chatId,
            "⚠️ No está configurado el dashboard/linking (faltan variables de entorno)."
          );
          return;
        }
        const nowSec = Math.floor(Date.now() / 1000);
        const payload = {
          chat_id: chatId,
          iat: nowSec,
          exp: nowSec + 10 * 60,
          nonce: crypto.randomUUID()
        };
        const token = signLinkToken(payload, secret);
        const linkUrl = `${baseUrl}/link?token=${token}`;
        await sendMessage(
          chatId,
          "🔗 Para vincular tu cuenta, abre este enlace (expira en 10 min):\n" +
            `${linkUrl}\n\n` +
            "Después podrás abrir tu dashboard sin pasar chat_id manualmente."
        );
        return;
      }

      if (matchesCommand(text, "dashboard")) {
        option = "command:dashboard";
        const baseUrl = normalizeBaseUrl(process.env.DASHBOARD_BASE_URL);
        if (!baseUrl) {
          await sendMessage(
            chatId,
            "⚠️ No está configurado el dashboard/linking (faltan variables de entorno)."
          );
          return;
        }

        const now = new Date();
        const from = monthOffset(now, -6);
        const to = monthOffset(now, 6);
        const cleanUrl = `${baseUrl}/dashboard`;
        const fallbackUrl =
          `${baseUrl}/dashboard?chat_id=${encodeURIComponent(chatId)}` +
          `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
        await sendMessage(
          chatId,
          `📊 Abre tu dashboard:\n${cleanUrl}\n\nSi necesitas depurar:\n${fallbackUrl}`
        );
        return;
      }

      if (low.startsWith("/cuentas")) {
        option = "command:cuentas";
        const ledgerStart = Date.now();
        let bqMs = 0;
        try {
          const listStart = Date.now();
          let accounts = await listAccountsFn({ chatId, activeOnly: true });
          bqMs += Date.now() - listStart;

          if (!accounts.some((acc) => acc.account_type === "CASH")) {
            const createStart = Date.now();
            await createAccountFn({
              chatId,
              accountName: "Efectivo",
              institution: "Cash",
              accountType: "CASH",
              currency: "MXN"
            });
            bqMs += Date.now() - createStart;
            const refreshStart = Date.now();
            accounts = await listAccountsFn({ chatId, activeOnly: true });
            bqMs += Date.now() - refreshStart;
          }

          await sendMessage(chatId, formatAccountsList(accounts));
          logLedgerPerf({
            subtype: "list_accounts",
            bq_ms: bqMs,
            total_ms: Date.now() - ledgerStart,
            status: "ok"
          });
        } catch (err) {
          logLedgerPerf(
            {
              subtype: "list_accounts",
              bq_ms: bqMs,
              total_ms: Date.now() - ledgerStart,
              status: "error",
              error: shortError(err)
            },
            "warn"
          );
          throw err;
        }
        return;
      }

      if (low.startsWith("/alta_cuenta")) {
        option = "command:alta_cuenta";
        const ledgerStart = Date.now();
        let bqMs = 0;
        const parsed = parseAccountCommand(text);
        if (!parsed.ok) {
          const institutions = allowedInstitutionsList().join(", ");
          await sendMessage(
            chatId,
            "Formato: <code>/alta_cuenta Nombre | Institución | Tipo</code>\n" +
              `Ejemplo: <code>/alta_cuenta Nómina BBVA | BBVA | DEBIT</code>\n` +
              `Instituciones permitidas (DEBIT): ${escapeHtml(institutions)}`
          );
          logLedgerPerf({
            subtype: "create_account_invalid",
            bq_ms: 0,
            total_ms: Date.now() - ledgerStart,
            status: "ok"
          });
          return;
        }

        try {
          const insertStart = Date.now();
          const created = await createAccountFn({
            chatId,
            accountName: parsed.accountName,
            institution: parsed.institution,
            accountType: parsed.accountType,
            currency: parsed.currency
          });
          bqMs += Date.now() - insertStart;
          await sendMessage(
            chatId,
            `✅ Cuenta creada. ID: <code>${escapeHtml(created.account_id)}</code>`
          );
          logLedgerPerf({
            subtype: "create_account",
            bq_ms: bqMs,
            total_ms: Date.now() - ledgerStart,
            status: "ok"
          });
        } catch (err) {
          logLedgerPerf(
            {
              subtype: "create_account",
              bq_ms: bqMs,
              total_ms: Date.now() - ledgerStart,
              status: "error",
              error: shortError(err)
            },
            "warn"
          );
          throw err;
        }
        return;
      }

      if (low.startsWith("/mov")) {
        option = "command:mov";
        const ledgerStart = Date.now();
        let bqMs = 0;
        const parsed = parseMovementCommand(text);
        if (!parsed.ok) {
          await sendMessage(
            chatId,
            "Formato: <code>/mov retiro 2000 bbva</code>\n" +
              "<code>/mov deposito 2500 bbva nomina</code>\n" +
              "<code>/mov transfer 5000 bbva -> banorte</code>"
          );
          logLedgerPerf({
            subtype: "movement_invalid",
            bq_ms: 0,
            total_ms: Date.now() - ledgerStart,
            status: "ok"
          });
          return;
        }

        const listStart = Date.now();
        let accounts = await listAccountsFn({ chatId, activeOnly: true });
        bqMs += Date.now() - listStart;
        if (!accounts.some((acc) => acc.account_type === "CASH")) {
          const createStart = Date.now();
          await createAccountFn({
            chatId,
            accountName: "Efectivo",
            institution: "Cash",
            accountType: "CASH",
            currency: "MXN"
          });
          bqMs += Date.now() - createStart;
          const refreshStart = Date.now();
          accounts = await listAccountsFn({ chatId, activeOnly: true });
          bqMs += Date.now() - refreshStart;
        }

        const movementDate = new Date().toISOString().slice(0, 10);
        const draft = {
          movement_type: parsed.type,
          movement_date: movementDate,
          amount_mxn: parsed.amount,
          from_account_id: null,
          to_account_id: null,
          from_account_label: null,
          to_account_label: null,
          merchant: null,
          notes: null,
          raw_text: parsed.rawText,
          source: "telegram"
        };

        const buildOptions = (matches) =>
          matches.map((acc) => ({
            account_id: acc.account_id,
            label: accountLabel(acc)
          }));

        if (parsed.type === "WITHDRAWAL") {
          const matches = parsed.accountQuery
            ? matchAccountsByQuery(parsed.accountQuery, accounts, ["DEBIT"])
            : accounts.filter((acc) => acc.account_type === "DEBIT");

          if (matches.length === 1) {
            draft.from_account_id = matches[0].account_id;
            draft.from_account_label = accountLabel(matches[0]);
          } else if (matches.length > 1) {
            draft.__pending = { field: "from", options: buildOptions(matches) };
          } else {
            await sendMessage(chatId, "No encontré una cuenta débito activa.");
            logLedgerPerf({
              subtype: "movement_missing_account",
              bq_ms: bqMs,
              total_ms: Date.now() - ledgerStart,
              status: "ok"
            });
            return;
          }

          const cashAccount = getDefaultCashAccount(accounts);
          if (cashAccount) {
            draft.to_account_id = cashAccount.account_id;
            draft.to_account_label = accountLabel(cashAccount);
          }
        }

        if (parsed.type === "DEPOSIT") {
          const matches = parsed.accountQuery
            ? matchAccountsByQuery(parsed.accountQuery, accounts)
            : accounts;
          if (matches.length === 1) {
            draft.to_account_id = matches[0].account_id;
            draft.to_account_label = accountLabel(matches[0]);
          } else if (matches.length > 1) {
            draft.__pending = { field: "to", options: buildOptions(matches) };
          } else {
            await sendMessage(chatId, "No encontré la cuenta de destino.");
            logLedgerPerf({
              subtype: "movement_missing_account",
              bq_ms: bqMs,
              total_ms: Date.now() - ledgerStart,
              status: "ok"
            });
            return;
          }
        }

        if (parsed.type === "TRANSFER") {
          const fromMatches = matchAccountsByQuery(parsed.fromQuery, accounts);
          const toMatches = matchAccountsByQuery(parsed.toQuery, accounts);

          if (!fromMatches.length || !toMatches.length) {
            await sendMessage(chatId, "No encontré las cuentas de origen/destino.");
            logLedgerPerf({
              subtype: "movement_missing_account",
              bq_ms: bqMs,
              total_ms: Date.now() - ledgerStart,
              status: "ok"
            });
            return;
          }

          if (fromMatches.length === 1) {
            draft.from_account_id = fromMatches[0].account_id;
            draft.from_account_label = accountLabel(fromMatches[0]);
          } else {
            draft.__pending = { field: "from", options: buildOptions(fromMatches) };
          }

          if (toMatches.length === 1) {
            draft.to_account_id = toMatches[0].account_id;
            draft.to_account_label = accountLabel(toMatches[0]);
          } else if (draft.__pending) {
            draft.__pending_next = { field: "to", options: buildOptions(toMatches) };
          } else {
            draft.__pending = { field: "to", options: buildOptions(toMatches) };
          }
        }

        if (draft.__pending) {
          setLedgerDraft(chatId, draft);
          const fieldLabel = draft.__pending.field === "from" ? "origen" : "destino";
          await sendMessage(chatId, `Selecciona la cuenta de ${fieldLabel}:`, {
            reply_markup: buildAccountSelectKeyboard(
              draft.__pending.options,
              draft.__pending.field
            )
          });
          logLedgerPerf({
            subtype: "movement_select_account",
            bq_ms: bqMs,
            total_ms: Date.now() - ledgerStart,
            status: "ok"
          });
          return;
        }

        setLedgerDraft(chatId, draft);
        await sendMessage(chatId, formatMovementPreview(draft), {
          reply_markup: buildConfirmKeyboard()
        });
        logLedgerPerf({
          subtype: "movement_preview",
          bq_ms: bqMs,
          total_ms: Date.now() - ledgerStart,
          status: "ok"
        });
        return;
      }

      if (low === "/analisis") {
        option = "command:analisis";
        const draft = getDraft(chatId);
        const pendingDelete = getPendingDelete(chatId);
        if (draft || pendingDelete) {
          await sendMessage(
            chatId,
            "Antes de entrar a análisis, termina tu borrador o cancela con <b>cancelar</b>."
          );
          return;
        }

        if (typeof handleAnalysisCommand === "function") {
          await handleAnalysisCommand({ chatId, requestId });
          return;
        }
      }

      if (low === "confirmar" || low === "/confirm") {
        option = "command:confirm";
        const draft = getDraft(chatId);
        if (!draft) {
          await sendMessage(chatId, "No tengo borrador. Mándame un gasto primero.");
          return;
        }
        if (draft.is_msi && (!draft.msi_months || Number(draft.msi_months) <= 1)) {
          await sendMessage(
            chatId,
            "Faltan los meses MSI. Responde solo el número (ej: <code>6</code>)."
          );
          return;
        }
        if (!draft.payment_method) {
          await sendMessage(chatId, "Elige un método con botones o escribe cancelar.");
          return;
        }

        if (requestId) {
          draft.__perf = { ...draft.__perf, request_id: requestId };
        }

        const result = await saveExpenseFn({ chatId, draft });
        if (result.ok) {
          setLastExpenseId(chatId, result.expenseId);
          clearDraft(chatId);
        }
        return;
      }

      const deleteMatch = text.match(/^(borrar|delete|rm)\s+(\S+)$/i);
      if (deleteMatch) {
        option = "command:delete";
        const expenseId = deleteMatch[2];
        if (!isValidUuid(expenseId)) {
          await sendMessage(
            chatId,
            "UUID inválido. Ejemplo: <code>borrar 123e4567-e89b-12d3-a456-426614174000</code>."
          );
          return;
        }

        try {
          const expense = await getExpenseByIdFn({ chatId, expenseId });
          if (!expense) {
            await sendMessage(chatId, "No encontré ese gasto para este chat.");
            return;
          }

          const installmentsCount = await countInstallmentsForExpenseFn({
            chatId,
            expenseId
          });
          setPendingDelete(chatId, { expenseId, installmentsCount, requestId });

          await sendMessage(chatId, formatDeletePreview(expense, installmentsCount), {
            reply_markup: deleteConfirmKeyboardFn()
          });
        } catch (e) {
          logBigQueryError(e);
          await sendMessage(chatId, "❌ <b>No se pudo buscar el gasto</b>.");
        }
        return;
      }

      // =========================
      // FLUJO A: "Esperando meses" (MSI step 2)
      // =========================
      const existing = getDraft(chatId);
      if (existing?.__state === "awaiting_payment_method") {
        option = "draft:awaiting_payment_method";
        await sendMessage(chatId, "Elige un método con botones o escribe cancelar.");
        return;
      }

      if (existing?.__state === "awaiting_msi_months") {
        option = "draft:awaiting_msi_months";
        const n = parseJustMonths(text);
        if (!n) {
          await sendMessage(
            chatId,
            "Dime solo el número de meses (ej: <code>6</code>, <code>12</code>)."
          );
          return;
        }

        existing.is_msi = true;
        existing.msi_months = n;

        // total compra debe existir; si no, usa amount_mxn (por seguridad)
        if (!existing.msi_total_amount || Number(existing.msi_total_amount) <= 0) {
          existing.msi_total_amount = Number(existing.amount_mxn);
        }

        if (!existing.payment_method) {
          await sendMessage(chatId, "Elige un método con botones o escribe cancelar.");
          return;
        }

        const cacheMeta = existing.__perf?.cache_hit || { card_rules: null, llm: null };
        existing.__perf = { ...existing.__perf, cache_hit: cacheMeta };
        if (requestId) {
          existing.__perf = { ...existing.__perf, request_id: requestId };
        }

        existing.msi_start_month = await getBillingMonthForPurchaseFn({
          chatId,
          cardName: existing.payment_method,
          purchaseDateISO: existing.purchase_date,
          cacheMeta
        });

        // amount_mxn = mensual (cashflow)
        existing.amount_mxn = round2(Number(existing.msi_total_amount) / n);

        existing.__state = "ready_to_confirm";
        setDraft(chatId, existing);
        await sendMessage(chatId, preview(existing), {
          reply_markup: mainKeyboardFn()
        });
        return;
      }

      // =========================
      // Detecta si es MSI (FLUJO B) o normal (FLUJO C)
      // =========================
      const localParseStart = Date.now();
      let draft = localParseExpense(text);
      const localParseMs = Date.now() - localParseStart;

      console.info(
        `⏱️ local-parse=${localParseMs}ms amounts=${draft.__meta?.amounts_found || 0} msi=${draft.is_msi}`
      );

      const wantsMsi = draft.is_msi || looksLikeMsiText(text);

      if (!/\d/.test(text)) {
        option = "text:no_amount";
        await sendMessage(chatId, welcomeText());
        return;
      }

      draft.raw_text = text;
      draft.purchase_date = overrideRelativeDate(text, draft.purchase_date);
      draft.__perf = {
        parse_ms: localParseMs,
        cache_hit: { card_rules: null, llm: null },
        request_id: requestId
      };

      if (!isFinite(draft.amount_mxn) || draft.amount_mxn <= 0) {
        draft = naiveParse(text);
        draft.raw_text = text;
        draft.purchase_date = overrideRelativeDate(text, draft.purchase_date);
        draft.__perf = {
          parse_ms: localParseMs,
          cache_hit: { card_rules: null, llm: null },
          request_id: requestId
        };
      }

      if (wantsMsi) {
        draft.is_msi = true;
        draft.msi_total_amount = Number(draft.msi_total_amount || draft.amount_mxn);
      }

      draft.payment_method = null;
      draft.amex_ambiguous = false;

      const amountToken = draft.__meta?.amount_tokens?.[0] || "";
      draft.description = cleanTextForDescription(text, amountToken, null) || "Gasto";
      draft.merchant = guessMerchant(text) || "";
      draft.category = guessCategory(`${draft.merchant} ${draft.description}`);

      const err = validateDraft(draft, { skipPaymentMethod: true });
      if (err) {
        option = "draft:invalid";
        await sendMessage(chatId, err);
        return;
      }

      // =========================
      // FLUJO B: MSI (step 1)
      // - parsea todo lo que se pueda del gasto,
      // - guarda draft incompleto,
      // - pregunta meses.
      // =========================
      if (wantsMsi) {
        option = "draft:msi_step1";
        // interpretamos el monto del texto como TOTAL de la compra
        draft.is_msi = true;
        draft.msi_total_amount = Number(draft.msi_total_amount || draft.amount_mxn);

        if (!Number.isFinite(draft.msi_months) || draft.msi_months <= 1) {
          draft.msi_months = null;
          draft.__state = "awaiting_payment_method";

          setDraft(chatId, draft);
          const activeCards = await getActiveCardNamesFn(chatId);
          const paymentMethods = activeCards?.length ? activeCards : ALLOWED_PAYMENT_METHODS;

          await sendMessage(chatId, paymentMethodPreview(draft), {
            reply_markup: paymentMethodKeyboardFn(paymentMethods)
          });
          return;
        }

        draft.amount_mxn = round2(Number(draft.msi_total_amount) / draft.msi_months);
        draft.__state = "awaiting_payment_method";

        setDraft(chatId, draft);
        const activeCards = await getActiveCardNamesFn(chatId);
        const paymentMethods = activeCards?.length ? activeCards : ALLOWED_PAYMENT_METHODS;

        await sendMessage(chatId, paymentMethodPreview(draft), {
          reply_markup: paymentMethodKeyboardFn(paymentMethods)
        });
        return;
      }

      // =========================
      // FLUJO C: normal (sin MSI)
      // =========================
      option = "draft:normal";
      draft.is_msi = false;
      draft.msi_months = null;
      draft.msi_total_amount = null;
      draft.msi_start_month = null;

      draft.__state = "awaiting_payment_method";
      setDraft(chatId, draft);
      const activeCards = await getActiveCardNamesFn(chatId);
      const paymentMethods = activeCards?.length ? activeCards : ALLOWED_PAYMENT_METHODS;
      await sendMessage(chatId, paymentMethodPreview(draft), {
        reply_markup: paymentMethodKeyboardFn(paymentMethods)
      });
    } catch (error) {
      status = "error";
      errorShort = shortError(error);
      throw error;
    } finally {
      const totalMs = Date.now() - startedAt;
      logPerf(
        {
          request_id: requestId || null,
          flow: "message",
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
  };
}

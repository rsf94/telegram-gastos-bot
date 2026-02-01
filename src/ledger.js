import { escapeHtml } from "./telegram.js";

const INSTITUTION_ALLOWLIST = ["BBVA", "Banorte", "Santander"];
const ACCOUNT_TYPES = ["DEBIT", "CASH"];
const MOVEMENT_TYPES = ["DEPOSIT", "WITHDRAWAL", "TRANSFER"];

function stripAccents(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

export function normalizeText(value) {
  return stripAccents(value).toLowerCase();
}

export function normalizeInstitution(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const normalized = normalizeText(raw);
  const match = INSTITUTION_ALLOWLIST.find(
    (allowed) => normalizeText(allowed) === normalized
  );
  return match || "";
}

export function parseAccountCommand(text) {
  const body = String(text || "").replace(/^\/alta_cuenta\s*/i, "").trim();
  if (!body) {
    return { ok: false, error: "missing_body" };
  }

  const parts = body.includes("|")
    ? body.split("|").map((part) => part.trim())
    : body.split(",").map((part) => part.trim());

  const [accountName, institutionRaw, accountTypeRaw, currencyRaw] = parts;
  if (!accountName || !institutionRaw || !accountTypeRaw) {
    return { ok: false, error: "missing_fields" };
  }

  const accountType = String(accountTypeRaw).trim().toUpperCase();
  if (!ACCOUNT_TYPES.includes(accountType)) {
    return { ok: false, error: "invalid_type" };
  }

  let institution = String(institutionRaw || "").trim();
  if (accountType === "DEBIT") {
    const normalized = normalizeInstitution(institution);
    if (!normalized) {
      return { ok: false, error: "invalid_institution" };
    }
    institution = normalized;
  }

  if (accountType === "CASH" && !institution) {
    institution = "Cash";
  }

  const currency = String(currencyRaw || "MXN").trim().toUpperCase() || "MXN";

  return {
    ok: true,
    accountName: accountName.trim(),
    institution,
    accountType,
    currency
  };
}

function parseAmountFromText(text) {
  const match = text.match(/(\d+(?:[.,]\d{1,2})?)/);
  if (!match) return null;
  const amount = Number(match[1].replace(",", "."));
  if (!Number.isFinite(amount)) return null;
  return { amount, index: match.index ?? 0, raw: match[0] };
}

export function parseMovementCommand(text) {
  const body = String(text || "").replace(/^\/mov\s*/i, "").trim();
  if (!body) return { ok: false, error: "missing_body" };

  const normalized = normalizeText(body);

  let type = "";
  if (/^(retiro|retire|retira|retire|saque|sacar|saco)\b/.test(normalized)) {
    type = "WITHDRAWAL";
  } else if (/^(deposito|deposite|depositar|deposita|deposit)\b/.test(normalized)) {
    type = "DEPOSIT";
  } else if (
    /^(transfer|transferi|transferencia|pase|pase|paso|pasar)\b/.test(normalized) ||
    normalized.includes("->")
  ) {
    type = "TRANSFER";
  }

  if (!MOVEMENT_TYPES.includes(type)) {
    return { ok: false, error: "unknown_type" };
  }

  const amountResult = parseAmountFromText(normalized);
  if (!amountResult) {
    return { ok: false, error: "missing_amount" };
  }

  const afterAmount = normalized
    .slice((amountResult.index ?? 0) + amountResult.raw.length)
    .trim();

  if (type === "TRANSFER") {
    const match = afterAmount.match(/(.+?)\s*(?:->| a | hacia )\s*(.+)/);
    if (!match) {
      return { ok: false, error: "missing_accounts" };
    }
    const fromQuery = match[1].trim();
    const toQuery = match[2].trim();
    if (!fromQuery || !toQuery) {
      return { ok: false, error: "missing_accounts" };
    }
    return {
      ok: true,
      type,
      amount: amountResult.amount,
      fromQuery,
      toQuery,
      rawText: body
    };
  }

  const accountQuery = afterAmount.trim();
  return {
    ok: true,
    type,
    amount: amountResult.amount,
    accountQuery,
    rawText: body
  };
}

export function matchAccountsByQuery(query, accounts, allowedTypes) {
  const list = Array.isArray(accounts) ? accounts : [];
  const filtered = allowedTypes?.length
    ? list.filter((acc) => allowedTypes.includes(acc.account_type))
    : list;

  const normalizedQuery = normalizeText(query || "");
  if (!normalizedQuery) return [];

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  return filtered.filter((account) => {
    const haystack = normalizeText(
      `${account.account_name || ""} ${account.institution || ""} ${account.account_id || ""}`
    );
    return tokens.every((token) => haystack.includes(token));
  });
}

export function accountLabel(account) {
  const name = account?.account_name || "Cuenta";
  const inst = account?.institution ? ` (${account.institution})` : "";
  const type = account?.account_type ? ` ${account.account_type}` : "";
  return `${name}${inst}${type}`.trim();
}

export function formatAccountsList(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  if (!list.length) return "No hay cuentas activas.";
  const lines = ["📒 <b>Cuentas activas</b>"];
  for (const account of list) {
    const label = accountLabel(account);
    lines.push(`• <code>${escapeHtml(account.account_id)}</code> — ${escapeHtml(label)}`);
  }
  return lines.join("\n");
}

export function formatMovementPreview(draft) {
  const typeLabel = {
    WITHDRAWAL: "Retiro",
    DEPOSIT: "Depósito",
    TRANSFER: "Transferencia"
  };

  const lines = [
    "💸 <b>Confirmar movimiento</b>",
    `Tipo: <b>${escapeHtml(typeLabel[draft.movement_type] || draft.movement_type)}</b>`,
    `Fecha: <b>${escapeHtml(draft.movement_date)}</b>`,
    `Monto: <b>${escapeHtml(Number(draft.amount_mxn).toFixed(2))}</b>`
  ];

  if (draft.from_account_label) {
    lines.push(`Origen: <b>${escapeHtml(draft.from_account_label)}</b>`);
  }
  if (draft.to_account_label) {
    lines.push(`Destino: <b>${escapeHtml(draft.to_account_label)}</b>`);
  }
  if (draft.notes) {
    lines.push(`Notas: <b>${escapeHtml(draft.notes)}</b>`);
  }

  return lines.join("\n");
}

export function validateMovementDraft(draft) {
  const amount = Number(draft.amount_mxn);
  if (!Number.isFinite(amount) || amount <= 0) {
    return "El monto debe ser mayor a 0.";
  }

  if (draft.movement_type === "WITHDRAWAL" && !draft.from_account_id) {
    return "Falta la cuenta de origen.";
  }

  if (draft.movement_type === "DEPOSIT" && !draft.to_account_id) {
    return "Falta la cuenta de destino.";
  }

  if (
    draft.movement_type === "TRANSFER" &&
    (!draft.from_account_id || !draft.to_account_id)
  ) {
    return "Faltan cuentas de origen y/o destino.";
  }

  return null;
}

export function buildAccountSelectKeyboard(options, field) {
  const rows = (options || []).map((account) => [
    {
      text: account.label,
      callback_data: `ledger_select|${field}|${account.account_id}`
    }
  ]);
  rows.push([{ text: "❌ Cancelar", callback_data: "ledger_cancel" }]);
  return { inline_keyboard: rows };
}

export function buildConfirmKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "✅ Confirmar", callback_data: "ledger_confirm" },
        { text: "❌ Cancelar", callback_data: "ledger_cancel" }
      ]
    ]
  };
}

export function getDefaultCashAccount(accounts) {
  const cash = (accounts || []).filter((acc) => acc.account_type === "CASH");
  if (!cash.length) return null;
  if (cash.length === 1) return cash[0];
  const efectivo = cash.find(
    (acc) => normalizeText(acc.account_name) === "efectivo"
  );
  return efectivo || cash[0];
}

export function allowedInstitutionsList() {
  return [...INSTITUTION_ALLOWLIST];
}

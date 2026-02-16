export function examplesText() {
  return [
    "• 230 uber",
    "• 140 autolavado a 3 MSI",
    "• 2026-01-03 4417 azulejos 6 MSI"
  ].join("\n");
}

export function welcomeText() {
  return [
    "✅ Listo. Mándame un gasto así:",
    examplesText(),
    "",
    "Luego te pregunto el método de pago y confirmas con un botón.",
    "Escribe <b>ayuda</b> para ver más."
  ].join("\n");
}

export function helpText() {
  return [
    "🧾 <b>Ejemplos</b>",
    examplesText(),
    "",
    "📅 <b>Fechas</b>: hoy, ayer o YYYY-MM-DD.",
    "💳 <b>MSI</b>: escribe “a 3 MSI” o “6MSI”.",
    "",
    "🧹 <b>Cancelar</b>: escribe <b>cancelar</b>.",
    "🗑️ <b>Borrar</b>: /borrar <code>&lt;expense_id&gt;</code>",
    "📊 <b>Análisis</b>: /analisis",
    "✈️ <b>Viajes</b>: /viaje nuevo | /viaje listar | /viaje actual"
  ].join("\n");
}

export function formatExpenseDraftSummary(draft) {
  if (!draft) return "";
  const amount = draft.amount_mxn != null ? String(draft.amount_mxn) : "";
  const date = draft.purchase_date || "";
  const description = draft.description || "";
  return [amount, description, date].filter(Boolean).join(" ").trim();
}

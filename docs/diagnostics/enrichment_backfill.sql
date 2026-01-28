-- Backfill: encola enriquecimientos para gastos recientes con merchant vacío o category=Other.
-- Ajusta PROJECT_ID/DATASET, y ventana de fechas según tu necesidad.
INSERT INTO `PROJECT_ID.DATASET.enrichment_retry` (
  event_id,
  run_id,
  expense_id,
  chat_id,
  status,
  category,
  merchant,
  description,
  attempts,
  next_attempt_at,
  last_error,
  created_at,
  updated_at
)
SELECT
  GENERATE_UUID() AS event_id,
  'manual_backfill_2026_01_20' AS run_id,
  e.id AS expense_id,
  e.chat_id AS chat_id,
  'PENDING' AS status,
  NULL AS category,
  NULL AS merchant,
  NULL AS description,
  0 AS attempts,
  CURRENT_TIMESTAMP() AS next_attempt_at,
  'backfill_missing_enrichment' AS last_error,
  CURRENT_TIMESTAMP() AS created_at,
  CURRENT_TIMESTAMP() AS updated_at
FROM `PROJECT_ID.DATASET.expenses` e
WHERE e.created_at >= TIMESTAMP('2026-01-20')
  AND (e.category IS NULL OR e.category = 'Other'
       OR e.merchant IS NULL OR TRIM(e.merchant) = '');

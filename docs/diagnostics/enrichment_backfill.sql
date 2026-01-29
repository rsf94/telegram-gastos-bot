-- Backfill: encola enriquecimientos para gastos recientes con enrichment incompleto.
-- Ajusta PROJECT_ID/DATASET, y ventana de días según tu necesidad.
DECLARE days_back INT64 DEFAULT 14;
DECLARE run_id STRING DEFAULT FORMAT_TIMESTAMP(
  'manual_backfill_%Y%m%d_%H%M%S',
  CURRENT_TIMESTAMP()
);
DECLARE event_id STRING DEFAULT GENERATE_UUID();

INSERT INTO `PROJECT_ID.DATASET.enrichment_retry` (
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
  e.id AS expense_id,
  e.chat_id AS chat_id,
  'PENDING' AS status,
  NULL AS category,
  NULL AS merchant,
  NULL AS description,
  0 AS attempts,
  CURRENT_TIMESTAMP() AS next_attempt_at,
  CONCAT('backfill_missing_enrichment:', run_id, ':', event_id) AS last_error,
  CURRENT_TIMESTAMP() AS created_at,
  CURRENT_TIMESTAMP() AS updated_at
FROM `PROJECT_ID.DATASET.expenses` e
WHERE e.created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL days_back DAY)
  AND (
    e.category IS NULL OR e.category = 'Other'
    OR e.merchant IS NULL OR TRIM(e.merchant) = ''
    OR e.description IS NULL OR TRIM(e.description) = ''
  )
  AND NOT EXISTS (
    SELECT 1
    FROM `PROJECT_ID.DATASET.enrichment_retry` r
    WHERE r.expense_id = e.id
      AND r.chat_id = e.chat_id
      AND r.status IN ('PENDING', 'PROCESSING')
  );

-- Diagnóstico: % de gastos con merchant vacío y category=Other (pre/post 2026-01-20)
-- Ajusta PROJECT_ID/DATASET si aplica.
WITH base AS (
  SELECT
    IF(
      created_at >= TIMESTAMP('2026-01-20'),
      'post_2026-01-20',
      'pre_2026-01-20'
    ) AS period,
    category,
    merchant
  FROM `PROJECT_ID.DATASET.expenses`
  WHERE created_at >= TIMESTAMP('2025-12-20')
)
SELECT
  period,
  COUNT(*) AS total,
  SUM(IF(category IS NULL OR category = 'Other', 1, 0)) AS category_other_count,
  SAFE_DIVIDE(
    SUM(IF(category IS NULL OR category = 'Other', 1, 0)),
    COUNT(*)
  ) AS category_other_pct,
  SUM(IF(merchant IS NULL OR TRIM(merchant) = '', 1, 0)) AS merchant_empty_count,
  SAFE_DIVIDE(
    SUM(IF(merchant IS NULL OR TRIM(merchant) = '', 1, 0)),
    COUNT(*)
  ) AS merchant_empty_pct
FROM base
GROUP BY period
ORDER BY period;

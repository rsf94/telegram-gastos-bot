CREATE TABLE IF NOT EXISTS `project-c9256c63-847c-4b18-ac8.gastos.installments` (
  installment_id STRING NOT NULL,
  expense_id STRING NOT NULL,
  chat_id STRING NOT NULL,
  card_name STRING NOT NULL,
  billing_month DATE NOT NULL,         -- siempre YYYY-MM-01
  installment_number INT64 NOT NULL,   -- 1..N
  months_total INT64 NOT NULL,
  amount_mxn NUMERIC NOT NULL,
  status STRING NOT NULL,              -- 'SCHEDULED' | 'PAID' | 'CANCELLED'
  created_at TIMESTAMP NOT NULL
);

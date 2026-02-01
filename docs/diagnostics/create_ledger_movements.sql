CREATE TABLE IF NOT EXISTS `gastos.ledger_movements` (
  movement_id STRING NOT NULL,
  chat_id STRING NOT NULL,
  movement_date DATE NOT NULL,
  amount_mxn NUMERIC NOT NULL,
  type STRING,
  from_account_id STRING,
  to_account_id STRING,
  merchant STRING,
  notes STRING,
  raw_text STRING,
  source STRING,
  created_at TIMESTAMP
);

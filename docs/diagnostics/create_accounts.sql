CREATE TABLE IF NOT EXISTS `gastos.accounts` (
  account_id STRING NOT NULL,
  chat_id STRING NOT NULL,
  account_name STRING NOT NULL,
  institution STRING,
  account_type STRING,
  currency STRING,
  active BOOL,
  tags STRING,
  notes STRING,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);

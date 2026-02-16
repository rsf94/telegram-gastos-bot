CREATE TABLE IF NOT EXISTS `gastos.chat_links` (
  chat_id STRING NOT NULL,
  user_id STRING NOT NULL,
  provider STRING,
  status STRING NOT NULL,
  created_at TIMESTAMP NOT NULL,
  last_seen_at TIMESTAMP,
  metadata JSON
)
PARTITION BY DATE(created_at)
CLUSTER BY chat_id, user_id;

CREATE TABLE IF NOT EXISTS `gastos.users` (
  user_id STRING NOT NULL,
  email STRING NOT NULL,
  created_at TIMESTAMP NOT NULL,
  last_seen_at TIMESTAMP,
  metadata JSON
)
PARTITION BY DATE(created_at);

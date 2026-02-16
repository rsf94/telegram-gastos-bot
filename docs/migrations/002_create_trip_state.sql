CREATE TABLE IF NOT EXISTS `project-c9256c63-847c-4b18-ac8.gastos.trip_state` (
  chat_id STRING NOT NULL,
  active_trip_id STRING NOT NULL,
  set_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP,
  metadata JSON
);

CREATE TABLE IF NOT EXISTS `project-c9256c63-847c-4b18-ac8.gastos.trips` (
  trip_id STRING NOT NULL,
  chat_id STRING NOT NULL,
  name STRING NOT NULL,
  base_currency STRING,
  start_date DATE,
  end_date DATE,
  active BOOL,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP,
  metadata JSON
);

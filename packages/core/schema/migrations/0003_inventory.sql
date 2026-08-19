CREATE TABLE IF NOT EXISTS inventory (
  sku        TEXT PRIMARY KEY,
  stock      INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

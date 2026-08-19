CREATE TABLE IF NOT EXISTS orders (
  id                 TEXT PRIMARY KEY,
  email              TEXT NOT NULL,
  name               TEXT,
  phone              TEXT,
  items_json         TEXT NOT NULL,
  amount             INTEGER NOT NULL,
  shipping           INTEGER,
  address_json       TEXT,
  payment_intent     TEXT,
  custom_fields_json TEXT,
  status             TEXT NOT NULL DEFAULT 'pending',
  run_id             TEXT,
  email_status       TEXT CHECK (email_status IN ('sent', 'failed')),
  created_at         INTEGER NOT NULL,
  shipped_at         INTEGER
);

CREATE INDEX IF NOT EXISTS orders_payment_intent_idx ON orders(payment_intent);

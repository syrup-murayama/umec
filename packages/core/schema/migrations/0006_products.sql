CREATE TABLE IF NOT EXISTS products (
  sku TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  price INTEGER NOT NULL CHECK (price > 0),
  shipping_units INTEGER NOT NULL DEFAULT 1 CHECK (shipping_units > 0),
  images_json TEXT,
  gtin TEXT,
  category TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  low_stock_threshold INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

ALTER TABLE orders ADD COLUMN tracking_number TEXT;
ALTER TABLE orders ADD COLUMN carrier TEXT
  CHECK (carrier IN ('yamato', 'sagawa', 'japanpost', 'other') OR carrier IS NULL);

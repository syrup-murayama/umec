CREATE TABLE IF NOT EXISTS admin_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  delta INTEGER,
  reason TEXT,
  admin_email TEXT,
  actor TEXT NOT NULL DEFAULT 'human',
  detail_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_entity
  ON admin_audit_log(entity_type, entity_id, created_at);

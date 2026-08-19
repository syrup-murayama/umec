export type SnapshotColumn = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

export type SnapshotIndex = {
  name: string;
  unique: number;
  origin: string;
  columns: string[];
};

export type SnapshotForeignKey = {
  id: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
};

export type SnapshotTable = {
  name: string;
  sql: string | null;
  columns: SnapshotColumn[];
  indexes: SnapshotIndex[];
  foreignKeys: SnapshotForeignKey[];
};

export type SchemaSnapshot = {
  version: number;
  tables: Record<string, SnapshotTable>;
};

export const CORE_TABLES = [
  "processed_events",
  "orders",
  "inventory",
  "admin_audit_log",
  "products",
] as const;

export type CoreTableName = (typeof CORE_TABLES)[number];

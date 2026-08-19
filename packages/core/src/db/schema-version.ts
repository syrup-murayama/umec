import type { ShopDatabase } from "./d1.js";
import { currentSchemaVersion } from "./catalog.js";

export const TRACKING_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS umec_schema_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  core_version TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  time_travel_bookmark TEXT
);

CREATE TABLE IF NOT EXISTS umec_migrations (
  name TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('sql', 'upgrade')),
  applied_at INTEGER NOT NULL
);
`;

export type SchemaVersionRow = {
  version: number;
  core_version: string;
  applied_at: number;
  time_travel_bookmark: string | null;
};

export type AppliedMigrationRow = {
  name: string;
  checksum: string;
  kind: "sql" | "upgrade";
  applied_at: number;
};

export class SchemaVersionError extends Error {
  readonly dbVersion: number;
  readonly installedVersion: number;

  constructor(dbVersion: number, installedVersion: number) {
    super(
      `DB は schema v${dbVersion}。インストール中の @umec/core は v${installedVersion} までしか知らない。戻すには wrangler d1 time-travel restore --bookmark=<記録済み> のあと同じ core バージョンを入れ直すこと。down migration は無い。`,
    );
    this.name = "SchemaVersionError";
    this.dbVersion = dbVersion;
    this.installedVersion = installedVersion;
  }
}

export async function readSchemaVersion(db: ShopDatabase): Promise<SchemaVersionRow | null> {
  try {
    const row = await db
      .prepare("SELECT version, core_version, applied_at, time_travel_bookmark FROM umec_schema_version WHERE id = 1")
      .first<SchemaVersionRow>();
    return row ?? null;
  } catch {
    return null;
  }
}

export async function listAppliedMigrations(db: ShopDatabase): Promise<AppliedMigrationRow[]> {
  try {
    const result = await db
      .prepare("SELECT name, checksum, kind, applied_at FROM umec_migrations ORDER BY name")
      .all<AppliedMigrationRow>();
    return result.results ?? [];
  } catch {
    return [];
  }
}

export async function assertSchemaCompatible(
  db: ShopDatabase,
  installedVersion = currentSchemaVersion(),
): Promise<void> {
  const row = await readSchemaVersion(db);
  if (!row) return;
  if (row.version > installedVersion) {
    throw new SchemaVersionError(row.version, installedVersion);
  }
}

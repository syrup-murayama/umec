import type { ShopDatabase } from "./d1.js";
import {
  CORE_TABLES,
  type SchemaSnapshot,
  type SnapshotColumn,
  type SnapshotForeignKey,
  type SnapshotIndex,
  type SnapshotTable,
} from "./snapshot.js";

type PragmaColumn = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

type PragmaIndex = {
  name: string;
  unique: number;
  origin: string;
};

type PragmaIndexInfo = {
  name: string | null;
};

type PragmaForeignKey = {
  id: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
};

type MasterRow = {
  name: string;
  sql: string | null;
};

function asResults<T>(value: { results: T[] } | T[]): T[] {
  return Array.isArray(value) ? value : value.results;
}

export async function introspectSnapshot(
  db: ShopDatabase,
  version: number,
  tableNames: readonly string[] = CORE_TABLES,
): Promise<SchemaSnapshot> {
  const tables: Record<string, SnapshotTable> = {};

  for (const tableName of tableNames) {
    const columns = asResults(
      await db.prepare(`PRAGMA table_info(${quoteIdent(tableName)})`).all<PragmaColumn>(),
    ).map(
      (column): SnapshotColumn => ({
        cid: column.cid,
        name: column.name,
        type: column.type,
        notnull: column.notnull,
        dflt_value: column.dflt_value,
        pk: column.pk,
      }),
    );
    if (columns.length === 0) continue;

    const indexRows = asResults(
      await db.prepare(`PRAGMA index_list(${quoteIdent(tableName)})`).all<PragmaIndex>(),
    );
    const indexes: SnapshotIndex[] = [];
    for (const index of indexRows) {
      if (index.origin === "pk") continue;
      const indexColumns = asResults(
        await db.prepare(`PRAGMA index_info(${quoteIdent(index.name)})`).all<PragmaIndexInfo>(),
      )
        .map((info) => info.name)
        .filter((name): name is string => typeof name === "string");
      indexes.push({
        name: index.name,
        unique: index.unique,
        origin: index.origin,
        columns: indexColumns,
      });
    }
    indexes.sort((a, b) => a.name.localeCompare(b.name));

    const foreignKeys = asResults(
      await db.prepare(`PRAGMA foreign_key_list(${quoteIdent(tableName)})`).all<PragmaForeignKey>(),
    ).map(
      (fk): SnapshotForeignKey => ({
        id: fk.id,
        table: fk.table,
        from: fk.from,
        to: fk.to,
        on_update: fk.on_update,
        on_delete: fk.on_delete,
      }),
    );

    const master = await db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .bind(tableName)
      .first<MasterRow>();

    tables[tableName] = {
      name: tableName,
      sql: master?.sql ?? null,
      columns,
      indexes,
      foreignKeys,
    };
  }

  return { version, tables };
}

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

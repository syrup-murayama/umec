import { CORE_TABLES, type SchemaSnapshot, type SnapshotColumn, type SnapshotTable } from "./snapshot.js";

export type DriftKind = "compatible" | "incompatible";

export type DriftFinding = {
  kind: DriftKind;
  table: string;
  message: string;
};

export type DriftReport = {
  compatible: DriftFinding[];
  incompatible: DriftFinding[];
};

function columnKey(column: SnapshotColumn): string {
  return [
    column.name,
    column.type.toUpperCase(),
    String(column.notnull),
    String(column.pk),
    column.dflt_value ?? "",
  ].join("|");
}

function requiredColumns(table: SnapshotTable): SnapshotColumn[] {
  return table.columns;
}

export function classifyDrift(expected: SchemaSnapshot, actual: SchemaSnapshot): DriftReport {
  const compatible: DriftFinding[] = [];
  const incompatible: DriftFinding[] = [];

  for (const extraTable of Object.keys(actual.tables)) {
    if (!CORE_TABLES.includes(extraTable as (typeof CORE_TABLES)[number]) && !(extraTable in expected.tables)) {
      compatible.push({
        kind: "compatible",
        table: extraTable,
        message: `instance table "${extraTable}" is not owned by core`,
      });
    }
  }

  for (const tableName of CORE_TABLES) {
    const want = expected.tables[tableName];
    const got = actual.tables[tableName];
    if (!want) continue;
    if (!got) {
      incompatible.push({
        kind: "incompatible",
        table: tableName,
        message: `required table "${tableName}" is missing`,
      });
      continue;
    }

    const gotByName = new Map(got.columns.map((column) => [column.name, column]));
    for (const column of requiredColumns(want)) {
      const actualColumn = gotByName.get(column.name);
      if (!actualColumn) {
        incompatible.push({
          kind: "incompatible",
          table: tableName,
          message: `required column "${tableName}.${column.name}" is missing`,
        });
        continue;
      }
      if (columnKey(column) !== columnKey(actualColumn)) {
        incompatible.push({
          kind: "incompatible",
          table: tableName,
          message: `column "${tableName}.${column.name}" changed (type/null/pk/default)`,
        });
      }
    }

    const wantNames = new Set(want.columns.map((column) => column.name));
    for (const column of got.columns) {
      if (!wantNames.has(column.name)) {
        compatible.push({
          kind: "compatible",
          table: tableName,
          message: `instance column "${tableName}.${column.name}" is not owned by core`,
        });
      }
    }

    const wantPk = want.columns
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name)
      .join(",");
    const gotPk = got.columns
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name)
      .join(",");
    if (wantPk !== gotPk) {
      incompatible.push({
        kind: "incompatible",
        table: tableName,
        message: `primary key of "${tableName}" is ${gotPk || "(none)"}; expected ${wantPk}`,
      });
    }

    const wantSql = normalizeSql(want.sql);
    const gotSql = normalizeSql(got.sql);
    if (wantSql && gotSql && extractChecks(wantSql) !== extractChecks(gotSql)) {
      incompatible.push({
        kind: "incompatible",
        table: tableName,
        message: `CHECK constraint on "${tableName}" does not match snapshot`,
      });
    }

    const wantIndexes = new Set(want.indexes.map((index) => index.name));
    for (const index of got.indexes) {
      if (!wantIndexes.has(index.name)) {
        compatible.push({
          kind: "compatible",
          table: tableName,
          message: `instance index "${index.name}" on "${tableName}" is not owned by core`,
        });
      }
    }
    for (const index of want.indexes) {
      if (!got.indexes.some((actualIndex) => actualIndex.name === index.name)) {
        incompatible.push({
          kind: "incompatible",
          table: tableName,
          message: `required index "${index.name}" on "${tableName}" is missing`,
        });
      }
    }
  }

  return { compatible, incompatible };
}

function normalizeSql(sql: string | null): string {
  return (sql ?? "").replace(/\s+/g, " ").trim().toUpperCase();
}

function extractChecks(sql: string): string {
  const matches = sql.match(/CHECK\s*\((?:[^()]|\([^()]*\))*\)/g);
  return (matches ?? []).slice().sort().join(";");
}

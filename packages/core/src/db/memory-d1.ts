import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { ShopDatabase, ShopStatement } from "./d1.js";
import { splitSqlStatements } from "./sql.js";

function asSqlValues(values: unknown[]): SQLInputValue[] {
  return values.map((value): SQLInputValue => {
    if (value === undefined || value === null) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
    if (value instanceof Uint8Array) return value;
    throw new Error(`Unsupported SQL bind: ${typeof value}`);
  });
}

type MemoryStatement = ShopStatement & {
  _runSync(): { meta: { changes: number } };
};

export function createMemoryDatabase(): ShopDatabase & {
  execScript(sql: string): void;
  raw: DatabaseSync;
} {
  const raw = new DatabaseSync(":memory:");

  const prepare = (query: string): MemoryStatement => {
    let bound: unknown[] = [];
    const statement: MemoryStatement = {
      bind(...values: unknown[]) {
        bound = values;
        return statement;
      },
      async first<T = Record<string, unknown>>() {
        const row = raw.prepare(query).get(...asSqlValues(bound)) as T | undefined;
        return row ?? null;
      },
      async run() {
        return statement._runSync();
      },
      async all<T = Record<string, unknown>>() {
        const rows = raw.prepare(query).all(...asSqlValues(bound)) as T[];
        return { results: rows };
      },
      _runSync() {
        const result = raw.prepare(query).run(...asSqlValues(bound));
        return { meta: { changes: Number(result.changes) } };
      },
    };
    return statement;
  };

  return {
    raw,
    prepare,
    async batch(statements) {
      return statements.map((statement) => (statement as MemoryStatement)._runSync());
    },
    execScript(sql: string) {
      for (const statement of splitSqlStatements(sql)) {
        raw.exec(statement);
      }
    },
  };
}

export function applySql(db: { execScript(sql: string): void }, sql: string): void {
  db.execScript(sql);
}

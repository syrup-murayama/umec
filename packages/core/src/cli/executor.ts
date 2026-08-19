import type { UpgradeExecutor } from "../../schema/upgrades/types.js";
import type { ShopDatabase } from "../db/d1.js";
import { splitSqlStatements } from "../db/sql.js";

export type MigrationExecutor = UpgradeExecutor & {
  applySql(sql: string): Promise<void>;
  captureBookmark(): Promise<string | null>;
};

export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  throw new Error(`Unsupported SQL bind: ${typeof value}`);
}

export function bindSql(sql: string, params: unknown[] = []): string {
  let index = 0;
  return sql.replaceAll("?", () => {
    if (index >= params.length) throw new Error("Not enough SQL bind parameters");
    return sqlLiteral(params[index++]);
  });
}

export function executorFromDatabase(
  db: ShopDatabase,
  captureBookmark: () => Promise<string | null> = async () => null,
): MigrationExecutor {
  return {
    async exec(sql: string) {
      await db.prepare(sql).run();
    },
    async applySql(sql: string) {
      for (const statement of splitSqlStatements(sql)) {
        await db.prepare(statement).run();
      }
    },
    async all<T>(sql: string, params: unknown[] = []) {
      const statement = db.prepare(sql);
      if (params.length > 0) statement.bind(...params);
      const result = await statement.all<T>();
      return result.results ?? [];
    },
    async first<T>(sql: string, params: unknown[] = []) {
      const statement = db.prepare(sql);
      if (params.length > 0) statement.bind(...params);
      return statement.first<T>();
    },
    async run(sql: string, params: unknown[] = []) {
      const statement = db.prepare(sql);
      if (params.length > 0) statement.bind(...params);
      const result = await statement.run();
      return { changes: result.meta.changes };
    },
    captureBookmark,
  };
}

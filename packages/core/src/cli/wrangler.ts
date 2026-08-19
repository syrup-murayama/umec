import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bindSql, type MigrationExecutor } from "./executor.js";

export type WranglerRunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type RunCommand = (command: string, args: string[], cwd: string) => Promise<WranglerRunResult>;

export function defaultRunCommand(command: string, args: string[], cwd: string): Promise<WranglerRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export function parseJsonc(text: string): unknown {
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(stripped);
}

export function readD1DatabaseName(cwd: string, override?: string): string | null {
  if (override) return override;
  const path = join(cwd, "wrangler.jsonc");
  try {
    const parsed = parseJsonc(readFileSync(path, "utf8")) as {
      d1_databases?: Array<{ database_name?: string }>;
    };
    return parsed.d1_databases?.[0]?.database_name ?? null;
  } catch {
    return null;
  }
}

function parseExecuteJson(stdout: string): { results: unknown[]; changes: number } {
  const trimmed = stdout.trim();
  if (!trimmed) return { results: [], changes: 0 };
  const start = trimmed.indexOf("[");
  const objStart = trimmed.indexOf("{");
  const cut =
    start >= 0 && (objStart < 0 || start < objStart)
      ? trimmed.slice(start)
      : objStart >= 0
        ? trimmed.slice(objStart)
        : trimmed;
  const parsed: unknown = JSON.parse(cut);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const first = rows[0] as { results?: unknown[]; meta?: { changes?: number } } | undefined;
  return {
    results: first?.results ?? [],
    changes: first?.meta?.changes ?? 0,
  };
}

export function createWranglerExecutor(options: {
  cwd: string;
  database: string;
  remote: boolean;
  runCommand?: RunCommand;
}): MigrationExecutor {
  const runCommand = options.runCommand ?? defaultRunCommand;
  const location = options.remote ? "--remote" : "--local";

  const execute = async (sql: string) => {
    const result = await runCommand(
      "wrangler",
      ["d1", "execute", options.database, location, "--json", "--command", sql],
      options.cwd,
    );
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || `wrangler d1 execute failed (${result.code})`);
    }
    return parseExecuteJson(result.stdout);
  };

  return {
    async exec(sql: string) {
      await execute(sql);
    },
    async applySql(sql: string) {
      const { splitSqlStatements } = await import("../db/sql.js");
      for (const statement of splitSqlStatements(sql)) {
        await execute(statement);
      }
    },
    async all<T>(sql: string, params: unknown[] = []) {
      const result = await execute(bindSql(sql, params));
      return result.results as T[];
    },
    async first<T>(sql: string, params: unknown[] = []) {
      const result = await execute(bindSql(sql, params));
      return (result.results[0] as T | undefined) ?? null;
    },
    async run(sql: string, params: unknown[] = []) {
      const result = await execute(bindSql(sql, params));
      return { changes: result.changes };
    },
    async captureBookmark() {
      const result = await runCommand(
        "wrangler",
        ["d1", "time-travel", "info", options.database, "--json"],
        options.cwd,
      );
      if (result.code !== 0) return null;
      try {
        const parsed = JSON.parse(result.stdout) as { bookmark?: string };
        return parsed.bookmark ?? null;
      } catch {
        return null;
      }
    },
  };
}

import { existsSync } from "node:fs";
import { join } from "node:path";
import { upgradeV2toV6 } from "../../schema/upgrades/v2-to-v6.js";
import { currentSchemaVersion, listCoreMigrations } from "../db/catalog.js";
import { classifyDrift } from "../db/drift.js";
import { introspectSnapshot } from "../db/introspect.js";
import type { SchemaSnapshot } from "../db/snapshot.js";
import { sha256File } from "./checksum.js";
import type { MigrationExecutor } from "./executor.js";
import type { Printer } from "./migrate.js";

export type DoctorOptions = {
  cwd: string;
  executor?: MigrationExecutor;
  snapshot: SchemaSnapshot;
  print?: Printer;
};

export type DoctorResult = {
  exitCode: number;
  lines: string[];
};

export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const print = options.print ?? (() => {});
  const lines: string[] = [];
  const installed = currentSchemaVersion();
  let exitCode = 0;

  const say = (line: string) => {
    lines.push(line);
    print(line);
  };

  say(`installed schema version: ${installed}`);

  if (!options.executor) {
    say("no database executor; offline checks only");
  } else {
    try {
      const version = await options.executor.first<{ version: number; core_version: string }>(
        "SELECT version, core_version FROM umec_schema_version WHERE id = 1",
      );
      if (!version) {
        say("umec_schema_version: missing (run umec migrate)");
      } else {
        say(`database schema version: ${version.version} (core ${version.core_version})`);
        if (version.version > installed) {
          exitCode = 1;
          say(
            `DB は schema v${version.version}。インストール中の @umec/core は v${installed} までしか知らない。戻すには wrangler d1 time-travel restore --bookmark=<記録済み> のあと同じ core バージョンを入れ直すこと。down migration は無い。`,
          );
        }
      }
    } catch {
      say("umec_schema_version: unreadable (run umec migrate)");
    }

    const actual = await introspectViaExecutor(options.executor, options.snapshot.version);
    const drift = classifyDrift(options.snapshot, actual);
    for (const finding of drift.compatible) say(`warn: ${finding.message}`);
    for (const finding of drift.incompatible) {
      exitCode = 1;
      say(`error: ${finding.message}`);
    }
    if (await upgradeV2toV6.canApply(options.executor)) {
      exitCode = 1;
      say("error: orders は event_id PK の旧スキーマです。umec migrate --repair を実行してください。");
    }

    const applied = await options.executor.all<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM umec_migrations",
    ).catch(() => []);
    const appliedByName = new Map(applied.map((row) => [row.name, row.checksum]));
    for (const migration of listCoreMigrations()) {
      const expected = sha256File(migration.path);
      const got = appliedByName.get(migration.name);
      if (got && got !== expected) {
        exitCode = 1;
        say(`error: checksum mismatch ${migration.name}`);
      }
    }
  }

  const extensionsPath = join(options.cwd, "src/config/extensions.ts");
  if (!existsSync(extensionsPath)) {
    say("warn: src/config/extensions.ts がありません。拡張は umec extend で extras_json に足してください。");
  }

  return { exitCode, lines };
}

async function introspectViaExecutor(executor: MigrationExecutor, version: number) {
  const db = {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          this._params = values;
          return this;
        },
        _params: [] as unknown[],
        async first<T>() {
          return executor.first<T>(query, this._params);
        },
        async all<T>() {
          return { results: await executor.all<T>(query, this._params) };
        },
        async run() {
          const result = await executor.run(query, this._params);
          return { meta: { changes: result.changes } };
        },
      };
    },
    async batch() {
      return [];
    },
  };
  return introspectSnapshot(db, version);
}

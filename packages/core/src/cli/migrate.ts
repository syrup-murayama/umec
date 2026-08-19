import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { upgradeV2toV6 } from "../../schema/upgrades/v2-to-v6.js";
import type { UpgradeModule } from "../../schema/upgrades/types.js";
import { currentSchemaVersion, listCoreMigrations } from "../db/catalog.js";
import { classifyDrift, type DriftFinding } from "../db/drift.js";
import { introspectSnapshot } from "../db/introspect.js";
import { TRACKING_TABLES_SQL } from "../db/schema-version.js";
import { CORE_TABLES, type SchemaSnapshot } from "../db/snapshot.js";
import { sha256File } from "./checksum.js";
import type { MigrationExecutor } from "./executor.js";
import { findPackageRoot } from "../package-root.js";

export const CORE_UPGRADES: UpgradeModule[] = [upgradeV2toV6];

export type Printer = (message: string) => void;

export type MigrateOptions = {
  cwd: string;
  executor: MigrationExecutor;
  snapshot: SchemaSnapshot;
  dryRun?: boolean;
  adopt?: boolean;
  repair?: boolean;
  coreVersion: string;
  now?: number;
  print?: Printer;
};

export type MigrateResult = {
  exitCode: number;
  applied: string[];
  warnings: string[];
  error?: string;
  bookmark?: string | null;
};

type AppliedRow = { name: string; checksum: string; kind: string };

async function ensureTracking(executor: MigrationExecutor, dryRun: boolean, print: Printer): Promise<void> {
  print("ensure umec_schema_version / umec_migrations");
  if (dryRun) return;
  await executor.applySql(TRACKING_TABLES_SQL);
}

async function readApplied(executor: MigrationExecutor): Promise<AppliedRow[]> {
  try {
    return await executor.all<AppliedRow>("SELECT name, checksum, kind FROM umec_migrations");
  } catch {
    return [];
  }
}

async function readVersion(executor: MigrationExecutor): Promise<number | null> {
  try {
    const row = await executor.first<{ version: number }>(
      "SELECT version FROM umec_schema_version WHERE id = 1",
    );
    return row?.version ?? null;
  } catch {
    return null;
  }
}

async function recordMigration(
  executor: MigrationExecutor,
  name: string,
  checksum: string,
  kind: "sql" | "upgrade",
  now: number,
): Promise<void> {
  await executor.run(
    `INSERT INTO umec_migrations (name, checksum, kind, applied_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET checksum = excluded.checksum, kind = excluded.kind, applied_at = excluded.applied_at`,
    [name, checksum, kind, now],
  );
}

async function writeVersion(
  executor: MigrationExecutor,
  version: number,
  coreVersion: string,
  now: number,
  bookmark: string | null,
): Promise<void> {
  await executor.run(
    `INSERT INTO umec_schema_version (id, version, core_version, applied_at, time_travel_bookmark)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       version = excluded.version,
       core_version = excluded.core_version,
       applied_at = excluded.applied_at,
       time_travel_bookmark = excluded.time_travel_bookmark`,
    [version, coreVersion, now, bookmark],
  );
}

function listLocalMigrations(cwd: string): { name: string; path: string; sql: string }[] {
  const dir = join(cwd, "migrations", "local");
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => ({
        name: `local/${name}`,
        path: join(dir, name),
        sql: readFileSync(join(dir, name), "utf8"),
      }));
  } catch {
    return [];
  }
}

async function adoptD1History(
  executor: MigrationExecutor,
  now: number,
  print: Printer,
): Promise<{ adopted: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  let names: string[] = [];
  try {
    const rows = await executor.all<{ name: string }>("SELECT name FROM d1_migrations");
    names = rows.map((row) => row.name);
  } catch {
    throw new Error("d1_migrations が見つかりません。--adopt は wrangler 管理下の既存 D1 向けです。");
  }

  const core = listCoreMigrations();
  const byFile = new Map(core.map((migration) => [migration.name, migration]));
  const adopted: string[] = [];
  const legacy = await upgradeV2toV6.canApply(executor);

  for (const rawName of names) {
    const fileName = rawName.split("/").pop() ?? rawName;
    const migration = byFile.get(fileName);
    if (!migration) {
      warnings.push(`d1_migrations の ${rawName} は core に無いのでスキップ`);
      continue;
    }
    const checksum =
      fileName === "0002_orders.sql" && legacy
        ? (upgradeV2toV6.replacesChecksums[0] ?? sha256File(migration.path))
        : sha256File(migration.path);
    await recordMigration(executor, migration.name, checksum, "sql", now);
    adopted.push(migration.name);
    print(`adopt ${migration.name}`);
  }

  return { adopted, warnings };
}

async function snapshotFromExecutor(
  executor: MigrationExecutor,
  version: number,
): Promise<SchemaSnapshot> {
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
          const results = await executor.all<T>(query, this._params);
          return { results };
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

export async function runMigrate(options: MigrateOptions): Promise<MigrateResult> {
  const print = options.print ?? (() => {});
  const dryRun = options.dryRun === true;
  const now = options.now ?? Date.now();
  const applied: string[] = [];
  const warnings: string[] = [];
  const installedVersion = currentSchemaVersion();

  try {
    await ensureTracking(options.executor, dryRun, print);

    const dbVersion = dryRun ? null : await readVersion(options.executor);
    if (dbVersion != null && dbVersion > installedVersion) {
      return {
        exitCode: 1,
        applied,
        warnings,
        error: `DB は schema v${dbVersion}。インストール中の @umec/core は v${installedVersion} までしか知らない。戻すには wrangler d1 time-travel restore --bookmark=<記録済み> のあと同じ core バージョンを入れ直すこと。down migration は無い。`,
      };
    }

    if (options.adopt) {
      print("adopt d1_migrations → umec_migrations");
      if (dryRun) {
        return { exitCode: 0, applied: ["--adopt"], warnings };
      }
      const result = await adoptD1History(options.executor, now, print);
      applied.push(...result.adopted);
      warnings.push(...result.warnings);
      const bookmark = await options.executor.captureBookmark();
      const maxAdopted = result.adopted.reduce((max, name) => Math.max(max, Number(name.slice(0, 4)) || 0), 0);
      await writeVersion(options.executor, maxAdopted, options.coreVersion, now, bookmark);
      return { exitCode: 0, applied, warnings, bookmark };
    }

    if (!dryRun) {
      const actual = await snapshotFromExecutor(options.executor, options.snapshot.version);
      const fresh = CORE_TABLES.every((table) => !actual.tables[table]);
      if (!fresh) {
        const alreadyForDrift = await readApplied(options.executor);
        const pendingSql = listCoreMigrations()
          .filter((migration) => !alreadyForDrift.some((row) => row.name === migration.name))
          .map((migration) => migration.sql)
          .join("\n");
        const drift = classifyDrift(options.snapshot, actual);
        for (const finding of drift.compatible) {
          warnings.push(finding.message);
          print(`warn: ${finding.message}`);
        }
        const blocking = drift.incompatible.filter((finding) => !pendingMigrationFixes(pendingSql, finding));
        const repairable = options.repair && (await upgradeV2toV6.canApply(options.executor));
        if (blocking.length > 0 && !repairable) {
          const details = blocking.map((finding) => finding.message).join("; ");
          const hint = (await upgradeV2toV6.canApply(options.executor))
            ? " umec migrate --repair で v2-to-v6 を提案できます。"
            : "";
          return {
            exitCode: 1,
            applied,
            warnings,
            error: `非互換 drift のため migrate を拒否: ${details}.${hint}`,
          };
        }
      }
    }

    const already = dryRun ? [] : await readApplied(options.executor);
    const alreadyByName = new Map(already.map((row) => [row.name, row]));
    const coreMigrations = listCoreMigrations();

    for (const migration of coreMigrations) {
      const currentHash = sha256File(migration.path);
      const recorded = alreadyByName.get(migration.name);
      if (recorded && recorded.checksum !== currentHash) {
        const knownLegacy = CORE_UPGRADES.some((upgrade) => upgrade.replacesChecksums.includes(recorded.checksum));
        const canRepair = options.repair && knownLegacy && (await upgradeV2toV6.canApply(options.executor));
        if (!canRepair) {
          return {
            exitCode: 1,
            applied,
            warnings,
            error: `公開済み migration ${migration.name} の checksum が食い違っています。in-place 改変は禁止です。${knownLegacy ? "umec migrate --repair を使ってください。" : ""}`,
          };
        }
      }
    }

    let bookmark: string | null = null;
    if (!dryRun) {
      bookmark = await options.executor.captureBookmark();
      print(bookmark ? `time-travel bookmark ${bookmark}` : "time-travel bookmark unavailable");
    }

    if (options.repair) {
      for (const upgrade of CORE_UPGRADES) {
        const needed = dryRun ? true : await upgrade.canApply(options.executor);
        if (!needed) continue;
        print(`upgrade ${upgrade.name} (${upgrade.fromVersion} → ${upgrade.toVersion})`);
        if (dryRun) {
          applied.push(upgrade.name);
          continue;
        }
        await upgrade.apply(options.executor);
        await recordMigration(options.executor, upgrade.name, `upgrade:${upgrade.name}`, "upgrade", now);
        applied.push(upgrade.name);
        const ordersMigration = coreMigrations.find((migration) => migration.name === "0002_orders.sql");
        if (ordersMigration) {
          await recordMigration(options.executor, ordersMigration.name, sha256File(ordersMigration.path), "sql", now);
        }
      }
    }

    for (const migration of coreMigrations) {
      if (alreadyByName.get(migration.name)?.checksum === sha256File(migration.path)) continue;
      if (alreadyByName.has(migration.name) && !options.repair) continue;
      print(`apply core/${migration.name}`);
      if (dryRun) {
        applied.push(migration.name);
        continue;
      }
      await options.executor.applySql(migration.sql);
      await recordMigration(options.executor, migration.name, sha256File(migration.path), "sql", now);
      applied.push(migration.name);
    }

    for (const local of listLocalMigrations(options.cwd)) {
      const hash = sha256File(local.path);
      if (alreadyByName.get(local.name)?.checksum === hash) continue;
      print(`apply ${local.name}`);
      if (dryRun) {
        applied.push(local.name);
        continue;
      }
      await options.executor.applySql(local.sql);
      await recordMigration(options.executor, local.name, hash, "sql", now);
      applied.push(local.name);
    }

    if (!dryRun) {
      await writeVersion(options.executor, installedVersion, options.coreVersion, now, bookmark);
    } else {
      print(`would set umec_schema_version.version = ${installedVersion}`);
    }

    return { exitCode: 0, applied, warnings, bookmark };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, applied, warnings, error: message };
  }
}

function pendingMigrationFixes(pendingSql: string, finding: DriftFinding): boolean {
  if (finding.message.includes(`required table "${finding.table}" is missing`)) {
    return new RegExp(`CREATE TABLE(?: IF NOT EXISTS)?\\s+${finding.table}\\b`, "i").test(pendingSql);
  }
  const missingColumn = finding.message.match(/required column "[^."]+\.([^"]+)" is missing/);
  if (missingColumn?.[1]) {
    return new RegExp(`ADD COLUMN\\s+${missingColumn[1]}\\b`, "i").test(pendingSql);
  }
  return false;
}

export function coreVersionFromPackage(root = findPackageRoot()): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  return pkg.version;
}

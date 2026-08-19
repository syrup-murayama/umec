import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSnapshotJson } from "../db/catalog.js";
import type { SchemaSnapshot } from "../db/snapshot.js";
import { findPackageRoot } from "../package-root.js";
import { runDoctor } from "./doctor.js";
import { runExtend } from "./extend.js";
import { coreVersionFromPackage, runMigrate, type MigrateOptions } from "./migrate.js";
import { createWranglerExecutor, readD1DatabaseName, type RunCommand } from "./wrangler.js";
import type { MigrationExecutor } from "./executor.js";

export type CliIo = {
  cwd?: string;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
  executor?: MigrationExecutor;
  runCommand?: RunCommand;
};

export function parseArgs(argv: string[]): {
  command: string | null;
  flags: Record<string, string | boolean>;
} {
  const flags: Record<string, string | boolean> = {};
  let command: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--") && name !== "dry-run" && name !== "adopt" && name !== "repair" && name !== "remote" && name !== "local") {
        flags[name] = next;
        i += 1;
      } else {
        flags[name] = true;
      }
      continue;
    }
    if (!command) command = arg;
  }
  return { command, flags };
}

function usage(): string {
  return `Usage:
  umec migrate [--dry-run] [--local|--remote] [--adopt] [--repair] [--database NAME]
  umec doctor [--local|--remote] [--database NAME]
  umec extend [--key NAME] [--type boolean|string|number]`;
}

export async function runCli(argv: string[], io: CliIo = {}): Promise<number> {
  const cwd = io.cwd ?? process.cwd();
  const stdout = io.stdout ?? ((message) => console.log(message));
  const stderr = io.stderr ?? ((message) => console.error(message));
  const { command, flags } = parseArgs(argv);

  if (!command || command === "help" || flags.help) {
    stdout(usage());
    return command ? 0 : 1;
  }

  const snapshot = loadSnapshotJson() as SchemaSnapshot;
  const remote = flags.remote === true;
  const database = typeof flags.database === "string" ? flags.database : readD1DatabaseName(cwd);

  const executor =
    io.executor ??
    (command === "extend" || (command === "migrate" && flags["dry-run"] === true)
      ? undefined
      : database
        ? createWranglerExecutor({ cwd, database, remote, runCommand: io.runCommand })
        : undefined);

  if (command === "migrate") {
    if (flags["dry-run"] === true && !io.executor) {
      const migrations = (await import("../db/catalog.js")).listCoreMigrations();
      stdout("dry-run (no D1 connection)");
      stdout("ensure umec_schema_version / umec_migrations");
      for (const migration of migrations) stdout(`apply core/${migration.name}`);
      stdout(`would set umec_schema_version.version = ${snapshot.version}`);
      return 0;
    }
    if (!executor) {
      stderr("wrangler.jsonc の d1_databases[0].database_name が見つかりません。--database を指定してください。");
      return 1;
    }
    const options: MigrateOptions = {
      cwd,
      executor,
      snapshot,
      dryRun: flags["dry-run"] === true,
      adopt: flags.adopt === true,
      repair: flags.repair === true,
      coreVersion: coreVersionFromPackage(),
      print: stdout,
    };
    const result = await runMigrate(options);
    for (const warning of result.warnings) stdout(`warn: ${warning}`);
    if (result.error) stderr(result.error);
    return result.exitCode;
  }

  if (command === "doctor") {
    const result = await runDoctor({
      cwd,
      executor,
      snapshot,
      print: stdout,
    });
    return result.exitCode;
  }

  if (command === "extend") {
    const result = runExtend({
      cwd,
      key: typeof flags.key === "string" ? flags.key : undefined,
      type: typeof flags.type === "string" ? flags.type : undefined,
      print: stdout,
    });
    if (result.error) stderr(result.error);
    return result.exitCode;
  }

  stderr(usage());
  return 1;
}

function isDirectRun(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  return /(?:^|[\\/])cli(?:\.js)?$/.test(invoked) || invoked.includes(`${join("dist", "cli")}`);
}

if (isDirectRun()) {
  const pkg = JSON.parse(readFileSync(join(findPackageRoot(), "package.json"), "utf8")) as { version: string };
  if (process.argv.includes("--version") || process.argv.includes("-V")) {
    console.log(pkg.version);
    process.exit(0);
  }
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}

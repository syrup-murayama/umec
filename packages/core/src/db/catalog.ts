import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findPackageRoot } from "../package-root.js";

export type CoreMigration = {
  name: string;
  version: number;
  path: string;
  sql: string;
};

const MIGRATION_NAME = /^(\d{4})_.+\.sql$/;

export function schemaDir(root = findPackageRoot()): string {
  return join(root, "schema");
}

export function migrationsDir(root = findPackageRoot()): string {
  return join(schemaDir(root), "migrations");
}

export function listCoreMigrations(root = findPackageRoot()): CoreMigration[] {
  const dir = migrationsDir(root);
  return readdirSync(dir)
    .filter((name) => MIGRATION_NAME.test(name))
    .sort()
    .map((name) => {
      const match = MIGRATION_NAME.exec(name);
      if (!match) throw new Error(`Invalid migration name: ${name}`);
      const version = Number(match[1]);
      const path = join(dir, name);
      return {
        name,
        version,
        path,
        sql: readFileSync(path, "utf8"),
      };
    });
}

export function currentSchemaVersion(root = findPackageRoot()): number {
  const migrations = listCoreMigrations(root);
  const last = migrations[migrations.length - 1];
  if (!last) throw new Error("No core migrations found");
  return last.version;
}

export function loadSnapshotJson(root = findPackageRoot()): unknown {
  return JSON.parse(readFileSync(join(schemaDir(root), "snapshot.json"), "utf8"));
}

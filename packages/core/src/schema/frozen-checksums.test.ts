import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadFrozenChecksums, sha256File } from "../cli/checksum.js";
import { findPackageRoot } from "../package-root.js";

function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

function originFrozen(): Record<string, string> | null {
  try {
    const text = execFileSync("git", ["show", "origin/main:packages/core/schema/frozen-checksums.json"], {
      encoding: "utf8",
      cwd: repoRoot(),
    });
    return JSON.parse(text) as Record<string, string>;
  } catch {
    return null;
  }
}

describe("frozen migration checksums", () => {
  const root = findPackageRoot();
  const frozenPath = join(root, "schema/frozen-checksums.json");
  const frozen = loadFrozenChecksums(frozenPath);

  it("records every core migration and upgrade source file", () => {
    const migrations = readdirSync(join(root, "schema/migrations"))
      .filter((name) => name.endsWith(".sql"))
      .map((name) => `schema/migrations/${name}`);
    const upgrades = readdirSync(join(root, "schema/upgrades"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => `schema/upgrades/${name}`);
    for (const rel of [...migrations, ...upgrades]) {
      expect(frozen[rel], rel).toBeTypeOf("string");
    }
  });

  it("matches working tree bytes for every existing key", () => {
    for (const [rel, expected] of Object.entries(frozen)) {
      expect(sha256File(join(root, rel)), rel).toBe(expected);
    }
  });

  it("does not rewrite keys that already exist on origin/main", () => {
    const published = originFrozen();
    if (!published) return;
    for (const [rel, expected] of Object.entries(published)) {
      expect(frozen[rel], rel).toBe(expected);
    }
  });
});

describe("core table files reject unsafe casts", () => {
  const root = findPackageRoot();
  const dirs = ["src/db", "src/cli", "schema/upgrades"];

  it("has no @ts-ignore or as any", () => {
    const hits: string[] = [];
    for (const dir of dirs) {
      walkTs(join(root, dir), hits);
    }
    expect(hits).toEqual([]);
  });
});

function walkTs(dir: string, hits: string[]): void {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) {
      walkTs(path, hits);
      continue;
    }
    if (!name.name.endsWith(".ts") || name.name.endsWith(".test.ts")) continue;
    const text = readFileSync(path, "utf8");
    if (/@ts-ignore|@ts-nocheck|\bas any\b/.test(text)) hits.push(path);
  }
}

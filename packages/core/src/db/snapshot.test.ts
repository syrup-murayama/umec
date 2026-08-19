import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findPackageRoot } from "../package-root.js";
import { currentSchemaVersion, listCoreMigrations, loadSnapshotJson } from "./catalog.js";
import { generateRowTypes } from "./generate-types.js";
import { introspectSnapshot } from "./introspect.js";
import { applySql, createMemoryDatabase } from "./memory-d1.js";
import type { SchemaSnapshot } from "./snapshot.js";

describe("schema snapshot", () => {
  it("matches PRAGMA after applying every core migration", async () => {
    const db = createMemoryDatabase();
    for (const migration of listCoreMigrations()) applySql(db, migration.sql);
    const expected = loadSnapshotJson() as SchemaSnapshot;
    const actual = await introspectSnapshot(db, currentSchemaVersion());
    expect(actual).toEqual(expected);
  });

  it("generated row types stay in sync with snapshot.json", () => {
    const snapshot = loadSnapshotJson() as SchemaSnapshot;
    const expected = generateRowTypes(snapshot);
    const actual = readFileSync(join(findPackageRoot(), "src/db/types.generated.ts"), "utf8");
    expect(actual).toBe(expected);
  });
});

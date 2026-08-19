import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listCoreMigrations, loadSnapshotJson } from "../db/catalog.js";
import { applySql, createMemoryDatabase } from "../db/memory-d1.js";
import type { SchemaSnapshot } from "../db/snapshot.js";
import { runCli } from "./index.js";
import { executorFromDatabase } from "./executor.js";
import type { DriftFinding } from "../db/drift.js";
import { coreVersionFromPackage, pendingMigrationFixes, runMigrate } from "./migrate.js";

const LEGACY_ORDERS = `CREATE TABLE IF NOT EXISTS orders (
  event_id       TEXT PRIMARY KEY NOT NULL,
  session_id     TEXT NOT NULL,
  amount_total   INTEGER NOT NULL,
  currency       TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  run_id         TEXT,
  created_at     INTEGER NOT NULL
);`;

describe("umec CLI", () => {
  it("dry-runs migrate without a D1 connection", async () => {
    const lines: string[] = [];
    const code = await runCli(["migrate", "--dry-run"], {
      cwd: tmpdir(),
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(lines.some((line) => line.includes("dry-run (no D1 connection)"))).toBe(true);
    expect(lines.some((line) => line.includes("0001_processed_events.sql"))).toBe(true);
    expect(lines.some((line) => line.includes("0007_orders_extras.sql"))).toBe(true);
  });

  it("applies core migrations to an empty database", async () => {
    const db = createMemoryDatabase();
    const result = await runMigrate({
      cwd: tmpdir(),
      executor: executorFromDatabase(db),
      snapshot: loadSnapshotJson() as SchemaSnapshot,
      coreVersion: coreVersionFromPackage(),
      now: 1,
    });
    expect(result.exitCode).toBe(0);
    expect(result.applied).toContain("0001_processed_events.sql");
    expect(result.applied).toContain("0007_orders_extras.sql");
    const version = await db.prepare("SELECT version FROM umec_schema_version WHERE id = 1").first<{ version: number }>();
    expect(version?.version).toBe(7);
  });

  it("adopts d1_migrations and repairs the v2 orders schema", async () => {
    const db = createMemoryDatabase();
    applySql(db, "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT)");
    applySql(db, listCoreMigrations()[0]!.sql);
    applySql(db, LEGACY_ORDERS);
    applySql(db, "ALTER TABLE orders ADD COLUMN tracking_number TEXT");
    for (const migration of listCoreMigrations()) {
      if (["0001_processed_events.sql", "0002_orders.sql", "0005_orders_tracking.sql"].includes(migration.name)) continue;
      applySql(db, migration.sql);
    }
    applySql(
      db,
      `INSERT INTO d1_migrations (name, applied_at) VALUES
        ('0001_processed_events.sql', '1'),
        ('0002_orders.sql', '1'),
        ('0003_inventory.sql', '1'),
        ('0004_admin_audit_log.sql', '1'),
        ('0005_orders_tracking.sql', '1'),
        ('0006_products.sql', '1')`,
    );
    applySql(
      db,
      `INSERT INTO orders (event_id, session_id, amount_total, currency, customer_email, created_at)
       VALUES ('evt_1', 'cs_1', 500, 'jpy', 'a@example.com', 1)`,
    );

    const executor = executorFromDatabase(db);
    const snapshot = loadSnapshotJson() as SchemaSnapshot;
    const adopted = await runMigrate({
      cwd: tmpdir(),
      executor,
      snapshot,
      adopt: true,
      coreVersion: coreVersionFromPackage(),
      now: 2,
    });
    expect(adopted.exitCode).toBe(0);

    const refused = await runMigrate({
      cwd: tmpdir(),
      executor,
      snapshot,
      coreVersion: coreVersionFromPackage(),
      now: 3,
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.error).toMatch(/repair|非互換|checksum/i);

    const repaired = await runMigrate({
      cwd: tmpdir(),
      executor,
      snapshot,
      repair: true,
      coreVersion: coreVersionFromPackage(),
      now: 4,
    });
    expect(repaired.exitCode).toBe(0);
    const row = await db.prepare("SELECT id, email FROM orders").first<{ id: string; email: string }>();
    expect(row).toEqual({ id: "cs_1", email: "a@example.com" });
    const extras = await db.prepare("PRAGMA table_info(orders)").all<{ name: string }>();
    expect(extras.results.some((column) => column.name === "extras_json")).toBe(true);
  });

  it("repairs a partially-migrated remote where only 0001-0003 were ever recorded", async () => {
    // Real-world repro (remote D1, 2026-08-19): d1_migrations only listed 0001-0003
    // as applied — 0004/0005/0006 were never reached, so --repair must apply them
    // fresh via the normal loop while 0005's ALTER is already baked into the
    // v2-to-v6 upgrade's orders_new DDL. This previously failed with
    // "duplicate column name: tracking_number" because only 0002 was marked
    // superseded, not 0005.
    const db = createMemoryDatabase();
    applySql(db, "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT)");
    applySql(db, listCoreMigrations()[0]!.sql);
    applySql(db, LEGACY_ORDERS);
    applySql(db, listCoreMigrations().find((migration) => migration.name === "0003_inventory.sql")!.sql);
    applySql(
      db,
      `INSERT INTO d1_migrations (name, applied_at) VALUES
        ('0001_processed_events.sql', '1'),
        ('0002_orders.sql', '1'),
        ('0003_inventory.sql', '1')`,
    );
    applySql(
      db,
      `INSERT INTO orders (event_id, session_id, amount_total, currency, customer_email, created_at)
       VALUES ('evt_1', 'cs_1', 500, 'jpy', 'a@example.com', 1)`,
    );

    const executor = executorFromDatabase(db);
    const snapshot = loadSnapshotJson() as SchemaSnapshot;
    const adopted = await runMigrate({
      cwd: tmpdir(),
      executor,
      snapshot,
      adopt: true,
      coreVersion: coreVersionFromPackage(),
      now: 2,
    });
    expect(adopted.exitCode).toBe(0);

    const repaired = await runMigrate({
      cwd: tmpdir(),
      executor,
      snapshot,
      repair: true,
      coreVersion: coreVersionFromPackage(),
      now: 3,
    });
    expect(repaired.exitCode).toBe(0);

    const row = await db.prepare("SELECT id, email FROM orders").first<{ id: string; email: string }>();
    expect(row).toEqual({ id: "cs_1", email: "a@example.com" });
    const tables = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all<{ name: string }>();
    const tableNames = tables.results.map((table) => table.name);
    expect(tableNames).toContain("admin_audit_log");
    expect(tableNames).toContain("products");
    const columns = await db.prepare("PRAGMA table_info(orders)").all<{ name: string }>();
    const columnNames = columns.results.map((column) => column.name);
    expect(columnNames).toContain("extras_json");
    // grok review (2026-08-19): a fix that only updates the in-memory
    // alreadyByName Map without persisting 0005 to umec_migrations would still
    // pass the assertions above (the run completes; ALTER only fires once).
    // Assert the DB record directly, and that the next plain `migrate` call
    // stays a no-op — that's what a dropped recordMigration() call breaks.
    expect(columnNames).toContain("tracking_number");
    expect(columnNames).toContain("carrier");
    const recordedNames = (
      await db.prepare("SELECT name FROM umec_migrations").all<{ name: string }>()
    ).results.map((row) => row.name);
    expect(recordedNames).toContain("0005_orders_tracking.sql");

    const reMigrated = await runMigrate({
      cwd: tmpdir(),
      executor,
      snapshot,
      coreVersion: coreVersionFromPackage(),
      now: 4,
    });
    expect(reMigrated.exitCode).toBe(0);
    expect(reMigrated.applied).toEqual([]);
  });

  it("pendingMigrationFixes scopes column checks to the owning table", () => {
    // The missing-column regex used to match "ADD COLUMN <name>" anywhere in
    // the pending SQL blob, so a finding for "inventory.sku" could be
    // false-matched by an unrelated "ALTER TABLE orders ADD COLUMN sku"
    // pending elsewhere.
    const finding: DriftFinding = {
      kind: "incompatible",
      table: "inventory",
      message: 'required column "inventory.sku" is missing',
    };
    expect(pendingMigrationFixes("ALTER TABLE orders ADD COLUMN sku TEXT;", finding)).toBe(false);
    expect(pendingMigrationFixes("ALTER TABLE inventory ADD COLUMN sku TEXT;", finding)).toBe(true);
  });

  it("scaffolds extras_json extensions without ALTER", () => {
    const cwd = mkdtempSync(join(tmpdir(), "umec-extend-"));
    mkdirSync(join(cwd, "src/config"), { recursive: true });
    const lines: string[] = [];
    return runCli(["extend", "--key", "giftWrap", "--type", "boolean"], {
      cwd,
      stdout: (line) => lines.push(line),
    }).then((code) => {
      expect(code).toBe(0);
      const source = readFileSync(join(cwd, "src/config/extensions.ts"), "utf8");
      expect(source).toContain("giftWrap: z.boolean().optional()");
      expect(source).not.toContain("ALTER TABLE");
    });
  });
});

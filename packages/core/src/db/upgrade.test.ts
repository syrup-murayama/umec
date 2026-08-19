import { describe, expect, it } from "vitest";
import { applyV2toV6, detectLegacyOrdersPk, UPGRADE_PAGE_SIZE } from "../../schema/upgrades/v2-to-v6.js";
import { executorFromDatabase } from "../cli/executor.js";
import { listCoreMigrations } from "./catalog.js";
import { introspectSnapshot } from "./introspect.js";
import { applySql, createMemoryDatabase } from "./memory-d1.js";

const LEGACY_ORDERS = `CREATE TABLE IF NOT EXISTS orders (
  event_id       TEXT PRIMARY KEY NOT NULL,
  session_id     TEXT NOT NULL,
  amount_total   INTEGER NOT NULL,
  currency       TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  run_id         TEXT,
  created_at     INTEGER NOT NULL
);`;

describe("v2-to-v6 upgrade", () => {
  it("uses 500-row pages", () => {
    expect(UPGRADE_PAGE_SIZE).toBe(500);
  });

  it("rebuilds event_id PK orders onto id PK and copies rows", async () => {
    const db = createMemoryDatabase();
    applySql(db, LEGACY_ORDERS);
    applySql(db, "ALTER TABLE orders ADD COLUMN tracking_number TEXT");
    for (const migration of listCoreMigrations()) {
      if (migration.name.startsWith("0001") || migration.name.startsWith("0002") || migration.name.startsWith("0005")) {
        continue;
      }
      applySql(db, migration.sql);
    }
    applySql(
      db,
      `INSERT INTO orders (event_id, session_id, amount_total, currency, customer_email, run_id, created_at, tracking_number)
       VALUES ('evt_1', 'cs_1', 1200, 'jpy', 'a@example.com', 'run', 1, '123'),
              ('evt_2', 'cs_2', 3400, 'jpy', 'b@example.com', null, 2, null)`,
    );

    const executor = executorFromDatabase(db);
    expect(await detectLegacyOrdersPk(executor)).toBe(true);
    await applyV2toV6(executor);
    expect(await detectLegacyOrdersPk(executor)).toBe(false);

    const row = await db.prepare("SELECT id, email, amount, items_json, tracking_number FROM orders WHERE id = ?").bind("cs_1").first<{
      id: string;
      email: string;
      amount: number;
      items_json: string;
      tracking_number: string | null;
    }>();
    expect(row).toEqual({
      id: "cs_1",
      email: "a@example.com",
      amount: 1200,
      items_json: "[]",
      tracking_number: "123",
    });
    const count = await db.prepare("SELECT COUNT(*) AS n FROM orders").first<{ n: number }>();
    expect(count?.n).toBe(2);

    const after = await introspectSnapshot(db, 6);
    expect(after.tables.orders?.columns.some((column) => column.name === "id" && column.pk === 1)).toBe(true);
    expect(after.tables.orders?.columns.some((column) => column.name === "event_id")).toBe(false);
  });

  it("refuses DROP when copied COUNT does not match", async () => {
    const db = createMemoryDatabase();
    applySql(db, LEGACY_ORDERS);
    applySql(
      db,
      `INSERT INTO orders (event_id, session_id, amount_total, currency, customer_email, created_at)
       VALUES ('evt_1', 'cs_1', 1, 'jpy', 'a@example.com', 1),
              ('evt_2', 'cs_1', 2, 'jpy', 'b@example.com', 2)`,
    );
    const executor = executorFromDatabase(db);
    await expect(applyV2toV6(executor)).rejects.toThrow(/COUNT mismatch|UNIQUE|constraint/i);
    const leftover = await db.prepare("SELECT event_id FROM orders ORDER BY event_id").all<{ event_id: string }>();
    expect(leftover.results.map((row) => row.event_id)).toEqual(["evt_1", "evt_2"]);
  });

  it("copies more than one page", async () => {
    const db = createMemoryDatabase();
    applySql(db, LEGACY_ORDERS);
    const values = Array.from({ length: 501 }, (_, index) => {
      const n = String(index).padStart(3, "0");
      return `('evt_${n}', 'cs_${n}', ${index}, 'jpy', 'u${n}@example.com', ${index})`;
    }).join(",");
    applySql(
      db,
      `INSERT INTO orders (event_id, session_id, amount_total, currency, customer_email, created_at) VALUES ${values}`,
    );
    await applyV2toV6(executorFromDatabase(db));
    const count = await db.prepare("SELECT COUNT(*) AS n FROM orders").first<{ n: number }>();
    expect(count?.n).toBe(501);
  });
});

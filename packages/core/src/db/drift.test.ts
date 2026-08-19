import { describe, expect, it } from "vitest";
import { classifyDrift } from "./drift.js";
import type { SchemaSnapshot, SnapshotTable } from "./snapshot.js";

function table(name: string, columns: SnapshotTable["columns"]): SnapshotTable {
  return { name, sql: null, columns, indexes: [], foreignKeys: [] };
}

function snapshot(tables: Record<string, SnapshotTable>): SchemaSnapshot {
  return { version: 7, tables };
}

const orders = table("orders", [
  { cid: 0, name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
  { cid: 1, name: "email", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
]);

describe("classifyDrift", () => {
  it("treats extra instance columns as compatible", () => {
    const expected = snapshot({ orders });
    const actual = snapshot({
      orders: table("orders", [
        ...orders.columns,
        { cid: 2, name: "gift_note", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      ]),
    });
    const report = classifyDrift(expected, actual);
    expect(report.incompatible).toEqual([]);
    expect(report.compatible.some((finding) => finding.message.includes("gift_note"))).toBe(true);
  });

  it("rejects missing required columns and pk changes", () => {
    const expected = snapshot({ orders });
    const actual = snapshot({
      orders: table("orders", [
        { cid: 0, name: "event_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      ]),
    });
    const report = classifyDrift(expected, actual);
    expect(report.incompatible.length).toBeGreaterThan(0);
    expect(report.incompatible.some((finding) => finding.message.includes("primary key"))).toBe(true);
  });
});

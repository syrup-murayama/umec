import { describe, expect, it } from "vitest";
import type { WebhookOrder } from "../webhook.js";
import { writeAuditLog, listAuditLog } from "./audit.js";
import { listCoreMigrations } from "./catalog.js";
import { claimEvent } from "./events.js";
import { adjustStock, decrementStock, getStock, restoreStock, setStock } from "./inventory.js";
import { applySql, createMemoryDatabase } from "./memory-d1.js";
import {
  listUnshipped,
  markShipped,
  recordEmailResult,
  recordExpiry,
  recordOrder,
  recordRefund,
  updateTracking,
} from "./orders.js";
import { createProduct, discontinueProduct, getProductRow, updateProduct } from "./products.js";

function order(overrides: Partial<WebhookOrder> = {}): WebhookOrder {
  return {
    id: "cs_1",
    email: "buyer@example.com",
    name: "Buyer",
    phone: null,
    items: [{ sku: "sku-1", quantity: 2 }],
    amount: 2000,
    shippingCost: 0,
    shippingAddress: null,
    paymentIntent: "pi_1",
    offerSlug: null,
    customFields: null,
    metadata: { run_id: "run" },
    createdAt: 100,
    ...overrides,
  };
}

describe("core db writes", () => {
  async function ready() {
    const db = createMemoryDatabase();
    for (const migration of listCoreMigrations()) applySql(db, migration.sql);
    await createProduct(
      db,
      "sku-1",
      {
        name: "Item",
        description: null,
        price: 1000,
        shippingUnits: 1,
        images: [],
        gtin: null,
        category: null,
        active: 1,
        lowStockThreshold: null,
      },
      "admin@example.com",
      1,
    );
    await setStock(db, "sku-1", 10, 1);
    return db;
  }

  it("records order lifecycle and unshipped reads", async () => {
    const db = await ready();
    expect(await claimEvent(db, "evt_1", 1)).toBe(true);
    expect(await claimEvent(db, "evt_1", 2)).toBe(false);

    await recordOrder(db, order(), JSON.stringify({ giftWrap: true }));
    await recordEmailResult(db, "cs_1", "sent");
    const unshipped = await listUnshipped(db, 1000);
    expect(unshipped).toHaveLength(1);
    expect(unshipped[0]?.id).toBe("cs_1");

    expect(await markShipped(db, "cs_1", { trackingNumber: "t1", carrier: "yamato", shippedAt: 200 })).toBe("ok");
    expect(await markShipped(db, "cs_1")).toBe("not_pending");
    expect(await updateTracking(db, "cs_1", "t2", "sagawa")).toBe("ok");

    const refunded = await recordRefund(db, "pi_1");
    expect(refunded?.items).toEqual([{ sku: "sku-1", quantity: 2 }]);
    await recordOrder(db, order({ id: "cs_2", paymentIntent: "pi_2", createdAt: 300 }));
    const expired = await recordExpiry(db, "cs_2");
    expect(expired?.items).toHaveLength(1);
  });

  it("guards stock and product writes", async () => {
    const db = await ready();
    await decrementStock(db, [{ sku: "sku-1", quantity: 3 }]);
    expect(await getStock(db, ["sku-1"])).toEqual(new Map([["sku-1", 7]]));
    await restoreStock(db, [{ sku: "sku-1", quantity: 1 }]);
    expect((await getStock(db, ["sku-1"])).get("sku-1")).toBe(8);
    expect(await adjustStock(db, "sku-1", -20)).toBe("insufficient");
    expect(await adjustStock(db, "missing", 1)).toBe("not_found");

    const updated = await updateProduct(db, "sku-1", { name: "Renamed" }, "admin@example.com", 3);
    expect(updated.result).toBe("ok");
    expect(updated.after?.name).toBe("Renamed");
    expect(await discontinueProduct(db, "sku-1", "admin@example.com", 4)).toBe("ok");
    expect((await getProductRow(db, "sku-1"))?.active).toBe(0);
    expect(await discontinueProduct(db, "sku-1", "admin@example.com", 5)).toBe("already_inactive");

    await writeAuditLog(db, { entityType: "product", entityId: "sku-1", action: "discontinue-product" }, 6);
    const logs = await listAuditLog(db, { entityType: "product" });
    expect(logs).toHaveLength(1);
  });
});

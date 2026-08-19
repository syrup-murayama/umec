import type { ShopDatabase } from "./d1.js";

export type InventoryItem = {
  sku: string;
  quantity: number;
};

export const MAX_STOCK_DELTA = 10000;

export type AdjustStockResult = "ok" | "not_found" | "insufficient";
export type SetStockResult = "ok" | "not_found";

export async function getStock(db: ShopDatabase, skus: string[]): Promise<Map<string, number>> {
  if (skus.length === 0) return new Map();

  const placeholders = skus.map(() => "?").join(", ");
  const result = await db
    .prepare(`SELECT sku, stock FROM inventory WHERE sku IN (${placeholders})`)
    .bind(...skus)
    .all<{ sku: string; stock: number }>();

  return new Map((result.results ?? []).map((row) => [row.sku, row.stock]));
}

export async function decrementStock(db: ShopDatabase, items: InventoryItem[]): Promise<void> {
  if (items.length === 0) return;

  const updatedAt = Date.now();
  for (const { sku, quantity } of items) {
    const result = await db
      .prepare("UPDATE inventory SET stock = stock - ?, updated_at = ? WHERE sku = ? AND stock >= ?")
      .bind(quantity, updatedAt, sku, quantity)
      .run();

    if (result.meta.changes === 0) {
      console.error("[inventory] stock decrement skipped: insufficient stock", { sku, quantity });
    }
  }
}

export async function restoreStock(db: ShopDatabase, items: InventoryItem[]): Promise<void> {
  if (items.length === 0) return;

  const updatedAt = Date.now();
  for (const { sku, quantity } of items) {
    await db
      .prepare("UPDATE inventory SET stock = stock + ?, updated_at = ? WHERE sku = ?")
      .bind(quantity, updatedAt, sku)
      .run();
  }
}

export async function setStock(
  db: ShopDatabase,
  sku: string,
  stock: number,
  updatedAt = Date.now(),
): Promise<SetStockResult> {
  const result = await db
    .prepare("UPDATE inventory SET stock = ?, updated_at = ? WHERE sku = ?")
    .bind(stock, updatedAt, sku)
    .run();
  return result.meta.changes === 0 ? "not_found" : "ok";
}

export async function adjustStock(db: ShopDatabase, sku: string, delta: number): Promise<AdjustStockResult> {
  const existing = await db.prepare("SELECT stock FROM inventory WHERE sku = ?").bind(sku).first<{ stock: number }>();
  if (!existing) return "not_found";

  const result = await db
    .prepare("UPDATE inventory SET stock = stock + ?, updated_at = ? WHERE sku = ? AND stock + ? >= 0")
    .bind(delta, Date.now(), sku, delta)
    .run();

  if (result.meta.changes === 0) return "insufficient";
  return "ok";
}

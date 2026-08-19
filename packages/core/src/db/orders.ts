import type { WebhookItem, WebhookOrder, WebhookRecordedOrder } from "../webhook.js";
import type { ShopDatabase } from "./d1.js";
import type { OrdersRow } from "./types.generated.js";

export type UnshippedOrder = Pick<OrdersRow, "id" | "name" | "items_json" | "amount" | "created_at">;

export type Carrier = "yamato" | "sagawa" | "japanpost" | "other";

export type MarkShippedResult = "ok" | "not_pending";
export type UpdateTrackingResult = "ok" | "not_found";

function parseCheckoutItems(items: string | null | undefined): WebhookItem[] {
  if (!items) return [];

  try {
    const parsed: unknown = JSON.parse(items);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((item): item is WebhookItem => {
      if (typeof item !== "object" || item === null) return false;
      const { sku, quantity } = item as { sku?: unknown; quantity?: unknown };
      return typeof sku === "string" && typeof quantity === "number" && Number.isSafeInteger(quantity) && quantity > 0;
    });
  } catch {
    return [];
  }
}

export async function recordOrder(
  db: ShopDatabase,
  order: WebhookOrder,
  extrasJson: string | null = null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO orders (
        id, email, name, phone, items_json, amount, shipping, address_json,
        payment_intent, custom_fields_json, run_id, extras_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      order.id,
      order.email,
      order.name,
      order.phone,
      JSON.stringify(order.items),
      order.amount,
      order.shippingCost,
      order.shippingAddress ? JSON.stringify(order.shippingAddress) : null,
      order.paymentIntent,
      order.customFields ? JSON.stringify(order.customFields) : null,
      order.metadata?.run_id ?? null,
      extrasJson,
      order.createdAt,
    )
    .run();
}

export async function recordRefund(
  db: ShopDatabase,
  paymentIntentId: string,
): Promise<WebhookRecordedOrder | null> {
  await db.prepare("UPDATE orders SET status = ? WHERE payment_intent = ?").bind("refunded", paymentIntentId).run();
  const orderRow = await db
    .prepare("SELECT items_json FROM orders WHERE payment_intent = ?")
    .bind(paymentIntentId)
    .first<{ items_json: string | null }>();
  if (!orderRow) return null;
  return { items: parseCheckoutItems(orderRow.items_json), offerSlug: null };
}

export async function recordExpiry(
  db: ShopDatabase,
  sessionId: string,
): Promise<WebhookRecordedOrder | null> {
  await db.prepare("UPDATE orders SET status = ? WHERE id = ?").bind("cancelled", sessionId).run();
  const orderRow = await db
    .prepare("SELECT items_json FROM orders WHERE id = ?")
    .bind(sessionId)
    .first<{ items_json: string | null }>();
  if (!orderRow) return null;
  return { items: parseCheckoutItems(orderRow.items_json), offerSlug: null };
}

export async function recordEmailResult(
  db: ShopDatabase,
  sessionId: string,
  status: "sent" | "failed",
): Promise<void> {
  await db.prepare("UPDATE orders SET email_status = ? WHERE id = ?").bind(status, sessionId).run();
}

export async function listUnshipped(db: ShopDatabase, cutoff: number): Promise<UnshippedOrder[]> {
  const result = await db
    .prepare(
      `SELECT id, name, items_json, amount, created_at
       FROM orders
       WHERE status = ? AND created_at < ?
       ORDER BY created_at ASC`,
    )
    .bind("pending", cutoff)
    .all<UnshippedOrder>();
  return result.results ?? [];
}

export async function getOrder(
  db: ShopDatabase,
  id: string,
): Promise<Pick<OrdersRow, "id" | "status" | "tracking_number" | "carrier"> | null> {
  const row = await db
    .prepare("SELECT id, status, tracking_number, carrier FROM orders WHERE id = ?")
    .bind(id)
    .first<Pick<OrdersRow, "id" | "status" | "tracking_number" | "carrier">>();
  return row ?? null;
}

export async function markShipped(
  db: ShopDatabase,
  id: string,
  options: { trackingNumber?: string | null; carrier?: Carrier | null; shippedAt?: number } = {},
): Promise<MarkShippedResult> {
  const result = await db
    .prepare(
      `UPDATE orders
       SET status = ?, shipped_at = ?, tracking_number = COALESCE(?, tracking_number), carrier = COALESCE(?, carrier)
       WHERE id = ? AND status = ?`,
    )
    .bind("shipped", options.shippedAt ?? Date.now(), options.trackingNumber ?? null, options.carrier ?? null, id, "pending")
    .run();
  return result.meta.changes === 0 ? "not_pending" : "ok";
}

export async function updateTracking(
  db: ShopDatabase,
  id: string,
  trackingNumber: string,
  carrier: string | null,
): Promise<UpdateTrackingResult> {
  const result = await db
    .prepare("UPDATE orders SET tracking_number = ?, carrier = ? WHERE id = ?")
    .bind(trackingNumber, carrier, id)
    .run();
  return result.meta.changes === 0 ? "not_found" : "ok";
}

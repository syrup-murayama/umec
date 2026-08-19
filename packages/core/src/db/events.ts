import type { ShopDatabase } from "./d1.js";

export async function claimEvent(db: ShopDatabase, eventId: string, now = Date.now()): Promise<boolean> {
  const claim = await db
    .prepare("INSERT OR IGNORE INTO processed_events (event_id, processed_at) VALUES (?, ?)")
    .bind(eventId, now)
    .run();
  return claim.meta.changes !== 0;
}

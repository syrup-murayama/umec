import type { ShopDatabase } from "./d1.js";
import type { AdminAuditLogRow } from "./types.generated.js";

export type AuditEntityType = "inventory" | "product" | "order";
export type AuditActor = "human" | "system" | "agent";

export type AdminAuditEntry = {
  entityType: AuditEntityType;
  entityId: string;
  action: string;
  delta?: number | null;
  reason?: string | null;
  adminEmail?: string | null;
  actor?: AuditActor;
  detail?: unknown;
};

export async function writeAuditLog(
  db: ShopDatabase,
  entry: AdminAuditEntry,
  createdAt = Date.now(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO admin_audit_log (
        entity_type, entity_id, action, delta, reason, admin_email, actor, detail_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      entry.entityType,
      entry.entityId,
      entry.action,
      entry.delta ?? null,
      entry.reason ?? null,
      entry.adminEmail ?? null,
      entry.actor ?? "human",
      entry.detail === undefined ? null : JSON.stringify(entry.detail),
      createdAt,
    )
    .run();
}

export async function listAuditLog(
  db: ShopDatabase,
  options: {
    entityType?: AuditEntityType;
    entityId?: string;
    limit?: number;
  } = {},
): Promise<AdminAuditLogRow[]> {
  const limit = options.limit ?? 50;
  const clauses: string[] = [];
  const binds: unknown[] = [];

  if (options.entityType) {
    clauses.push("entity_type = ?");
    binds.push(options.entityType);
  }
  if (options.entityId) {
    clauses.push("entity_id = ?");
    binds.push(options.entityId);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await db
    .prepare(
      `SELECT id, entity_type, entity_id, action, delta, reason, admin_email, actor, detail_json, created_at
       FROM admin_audit_log
       ${where}
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .bind(...binds, limit)
    .all<AdminAuditLogRow>();

  return result.results ?? [];
}

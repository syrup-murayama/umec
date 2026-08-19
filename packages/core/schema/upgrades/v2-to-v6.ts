import type { UpgradeExecutor, UpgradeModule } from "./types.js";

export const UPGRADE_PAGE_SIZE = 500;

export const LEGACY_0002_SQL = `CREATE TABLE IF NOT EXISTS orders (
  event_id       TEXT PRIMARY KEY NOT NULL,
  session_id     TEXT NOT NULL,
  amount_total   INTEGER NOT NULL,
  currency       TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  run_id         TEXT,
  created_at     INTEGER NOT NULL
);
`;

export const V6_ORDERS_DDL = `CREATE TABLE orders_new (
  id                 TEXT PRIMARY KEY,
  email              TEXT NOT NULL,
  name               TEXT,
  phone              TEXT,
  items_json         TEXT NOT NULL,
  amount             INTEGER NOT NULL,
  shipping           INTEGER,
  address_json       TEXT,
  payment_intent     TEXT,
  custom_fields_json TEXT,
  status             TEXT NOT NULL DEFAULT 'pending',
  run_id             TEXT,
  email_status       TEXT CHECK (email_status IN ('sent', 'failed')),
  created_at         INTEGER NOT NULL,
  shipped_at         INTEGER,
  tracking_number    TEXT,
  carrier            TEXT CHECK (carrier IN ('yamato', 'sagawa', 'japanpost', 'other') OR carrier IS NULL)
)`;

type LegacyOrderRow = {
  event_id: string;
  session_id?: string | null;
  amount_total?: number | null;
  amount?: number | null;
  customer_email?: string | null;
  email?: string | null;
  name?: string | null;
  phone?: string | null;
  items_json?: string | null;
  shipping?: number | null;
  address_json?: string | null;
  payment_intent?: string | null;
  custom_fields_json?: string | null;
  status?: string | null;
  run_id?: string | null;
  email_status?: string | null;
  created_at: number;
  shipped_at?: number | null;
  tracking_number?: string | null;
  carrier?: string | null;
};

type TableInfoRow = {
  name: string;
  pk: number;
};

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function detectLegacyOrdersPk(db: UpgradeExecutor): Promise<boolean> {
  const columns = await db.all<TableInfoRow>("PRAGMA table_info(orders)");
  if (columns.length === 0) return false;
  const eventId = columns.find((column) => column.name === "event_id");
  return eventId != null && eventId.pk === 1;
}

export function mapLegacyOrder(row: LegacyOrderRow): {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  items_json: string;
  amount: number;
  shipping: number | null;
  address_json: string | null;
  payment_intent: string | null;
  custom_fields_json: string | null;
  status: string;
  run_id: string | null;
  email_status: string | null;
  created_at: number;
  shipped_at: number | null;
  tracking_number: string | null;
  carrier: string | null;
} {
  const sessionId = asNullableString(row.session_id);
  const eventId = asString(row.event_id);
  return {
    id: sessionId && sessionId.length > 0 ? sessionId : eventId,
    email: asString(row.customer_email ?? row.email),
    name: asNullableString(row.name),
    phone: asNullableString(row.phone),
    items_json: asNullableString(row.items_json) ?? "[]",
    amount: asNumber(row.amount_total ?? row.amount),
    shipping: asNullableNumber(row.shipping),
    address_json: asNullableString(row.address_json),
    payment_intent: asNullableString(row.payment_intent),
    custom_fields_json: asNullableString(row.custom_fields_json),
    status: asNullableString(row.status) ?? "pending",
    run_id: asNullableString(row.run_id),
    email_status: asNullableString(row.email_status),
    created_at: asNumber(row.created_at),
    shipped_at: asNullableNumber(row.shipped_at),
    tracking_number: asNullableString(row.tracking_number),
    carrier: asNullableString(row.carrier),
  };
}

export async function applyV2toV6(db: UpgradeExecutor): Promise<void> {
  if (!(await detectLegacyOrdersPk(db))) {
    throw new Error("v2-to-v6: orders.event_id primary key not found; refuse to rebuild");
  }

  await db.exec("DROP TABLE IF EXISTS orders_new");
  await db.exec(V6_ORDERS_DDL);

  let cursor: string | null = null;
  for (;;) {
    const pageSql = cursor
      ? "SELECT * FROM orders WHERE event_id > ? ORDER BY event_id LIMIT ?"
      : "SELECT * FROM orders ORDER BY event_id LIMIT ?";
    const pageParams = cursor ? [cursor, UPGRADE_PAGE_SIZE] : [UPGRADE_PAGE_SIZE];
    const rows: LegacyOrderRow[] = await db.all<LegacyOrderRow>(pageSql, pageParams);
    if (rows.length === 0) break;

    for (const row of rows) {
      const mapped = mapLegacyOrder(row);
      await db.run(
        `INSERT INTO orders_new (
          id, email, name, phone, items_json, amount, shipping, address_json,
          payment_intent, custom_fields_json, status, run_id, email_status,
          created_at, shipped_at, tracking_number, carrier
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          mapped.id,
          mapped.email,
          mapped.name,
          mapped.phone,
          mapped.items_json,
          mapped.amount,
          mapped.shipping,
          mapped.address_json,
          mapped.payment_intent,
          mapped.custom_fields_json,
          mapped.status,
          mapped.run_id,
          mapped.email_status,
          mapped.created_at,
          mapped.shipped_at,
          mapped.tracking_number,
          mapped.carrier,
        ],
      );
    }

    const last: LegacyOrderRow | undefined = rows[rows.length - 1];
    if (!last) break;
    cursor = last.event_id;
    if (rows.length < UPGRADE_PAGE_SIZE) break;
  }

  const oldCount = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM orders");
  const newCount = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM orders_new");
  const expected = oldCount?.n ?? -1;
  const copied = newCount?.n ?? -2;
  if (expected !== copied) {
    throw new Error(
      `v2-to-v6: COUNT mismatch orders=${expected} orders_new=${copied}. DROP skipped. Restore from Time Travel bookmark.`,
    );
  }

  await db.exec("DROP TABLE orders");
  await db.exec("ALTER TABLE orders_new RENAME TO orders");
  await db.exec("CREATE INDEX IF NOT EXISTS orders_payment_intent_idx ON orders(payment_intent)");
}

export const upgradeV2toV6: UpgradeModule = {
  name: "v2-to-v6",
  fromVersion: 2,
  toVersion: 6,
  description: "Rebuild orders from event_id PK (v2) to id PK (v6)",
  replacesChecksums: ["ca6ec5c885f715a3ae65a7101787d66750ed831370dc2ecde0636cfc3cf83e24"],
  canApply: detectLegacyOrdersPk,
  apply: applyV2toV6,
};

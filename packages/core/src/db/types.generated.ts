// Generated from schema/snapshot.json. Do not edit by hand.
export const SNAPSHOT_SCHEMA_VERSION = 7 as const;

export type AdminAuditLogRow = {
  id: number;
  entity_type: string;
  entity_id: string;
  action: string;
  delta: number | null;
  reason: string | null;
  admin_email: string | null;
  actor: string;
  detail_json: string | null;
  created_at: number;
};
export type InventoryRow = {
  sku: string;
  stock: number;
  updated_at: number;
};
export type OrdersRow = {
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
  extras_json: string | null;
};
export type ProcessedEventsRow = {
  event_id: string;
  processed_at: number;
};
export type ProductsRow = {
  sku: string;
  name: string;
  description: string | null;
  price: number;
  shipping_units: number;
  images_json: string | null;
  gtin: string | null;
  category: string | null;
  active: number;
  low_stock_threshold: number | null;
  created_at: number;
  updated_at: number;
  updated_by: string | null;
};

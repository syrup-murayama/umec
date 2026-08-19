import type { ShopDatabase } from "./d1.js";
import type { ProductsRow } from "./types.generated.js";

export type ProductWriteFields = {
  name: string;
  description: string | null;
  price: number;
  shippingUnits: number;
  images: string[];
  gtin: string | null;
  category: string | null;
  active: 0 | 1;
  lowStockThreshold: number | null;
};

export type CreateProductResult = "ok" | "conflict";
export type UpdateProductResult = "ok" | "not_found";
export type DiscontinueProductResult = "ok" | "not_found" | "already_inactive";

export async function listProductRows(
  db: ShopDatabase,
  options: { includeInactive?: boolean } = {},
): Promise<ProductsRow[]> {
  const sql = options.includeInactive
    ? `SELECT sku, name, description, price, shipping_units, images_json, gtin, category,
              active, low_stock_threshold, created_at, updated_at, updated_by
       FROM products
       ORDER BY sku ASC`
    : `SELECT sku, name, description, price, shipping_units, images_json, gtin, category,
              active, low_stock_threshold, created_at, updated_at, updated_by
       FROM products
       WHERE active = 1
       ORDER BY sku ASC`;

  const result = await db.prepare(sql).all<ProductsRow>();
  return result.results ?? [];
}

export async function getProductRow(db: ShopDatabase, sku: string): Promise<ProductsRow | null> {
  const row = await db
    .prepare(
      `SELECT sku, name, description, price, shipping_units, images_json, gtin, category,
              active, low_stock_threshold, created_at, updated_at, updated_by
       FROM products
       WHERE sku = ?`,
    )
    .bind(sku)
    .first<ProductsRow>();
  return row ?? null;
}

export async function createProduct(
  db: ShopDatabase,
  sku: string,
  fields: ProductWriteFields,
  updatedBy: string | null,
  now = Date.now(),
): Promise<CreateProductResult> {
  const existing = await db.prepare("SELECT sku FROM products WHERE sku = ?").bind(sku).first<{ sku: string }>();
  if (existing) return "conflict";

  const imagesJson = fields.images.length > 0 ? JSON.stringify(fields.images) : null;
  await db.batch([
    db
      .prepare(
        `INSERT INTO products (
          sku, name, description, price, shipping_units, images_json, gtin, category,
          active, low_stock_threshold, created_at, updated_at, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        sku,
        fields.name,
        fields.description,
        fields.price,
        fields.shippingUnits,
        imagesJson,
        fields.gtin,
        fields.category,
        fields.active,
        fields.lowStockThreshold,
        now,
        now,
        updatedBy,
      ),
    db.prepare("INSERT OR IGNORE INTO inventory (sku, stock, updated_at) VALUES (?, ?, ?)").bind(sku, 0, now),
  ]);
  return "ok";
}

export async function updateProduct(
  db: ShopDatabase,
  sku: string,
  fields: Partial<ProductWriteFields>,
  updatedBy: string | null,
  now = Date.now(),
): Promise<{ result: UpdateProductResult; before: ProductsRow | null; after: ProductsRow | null }> {
  const existing = await getProductRow(db, sku);
  if (!existing) return { result: "not_found", before: null, after: null };

  const next = {
    name: fields.name ?? existing.name,
    description: fields.description !== undefined ? fields.description : existing.description,
    price: fields.price ?? existing.price,
    shippingUnits: fields.shippingUnits ?? existing.shipping_units,
    imagesJson:
      fields.images !== undefined
        ? fields.images.length > 0
          ? JSON.stringify(fields.images)
          : null
        : existing.images_json,
    gtin: fields.gtin !== undefined ? fields.gtin : existing.gtin,
    category: fields.category !== undefined ? fields.category : existing.category,
    active: fields.active ?? existing.active,
    lowStockThreshold:
      fields.lowStockThreshold !== undefined ? fields.lowStockThreshold : existing.low_stock_threshold,
  };

  await db
    .prepare(
      `UPDATE products
       SET name = ?, description = ?, price = ?, shipping_units = ?, images_json = ?,
           gtin = ?, category = ?, active = ?, low_stock_threshold = ?, updated_at = ?, updated_by = ?
       WHERE sku = ?`,
    )
    .bind(
      next.name,
      next.description,
      next.price,
      next.shippingUnits,
      next.imagesJson,
      next.gtin,
      next.category,
      next.active,
      next.lowStockThreshold,
      now,
      updatedBy,
      sku,
    )
    .run();

  const after = await getProductRow(db, sku);
  return { result: "ok", before: existing, after };
}

export async function discontinueProduct(
  db: ShopDatabase,
  sku: string,
  updatedBy: string | null,
  now = Date.now(),
): Promise<DiscontinueProductResult> {
  const existing = await db
    .prepare("SELECT sku, active FROM products WHERE sku = ?")
    .bind(sku)
    .first<{ sku: string; active: number }>();
  if (!existing) return "not_found";
  if (existing.active === 0) return "already_inactive";

  await db
    .prepare("UPDATE products SET active = 0, updated_at = ?, updated_by = ? WHERE sku = ?")
    .bind(now, updatedBy, sku)
    .run();
  return "ok";
}

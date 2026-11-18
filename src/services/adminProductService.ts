import { PoolClient } from "pg";
import { pool, withTransaction } from "../database/db";
import { HttpError, isUniqueViolation } from "../utils/httpError";
import { recordAuditLog } from "../utils/auditLog";

type Queryable = Pick<PoolClient, "query">;

export interface ProductListFilters {
  q?: string;
  category?: number;
  brand?: number;
  status?: string;
  featured?: boolean;
  stock?: string; // in | low | out | untracked
  minPrice?: number;
  maxPrice?: number;
  sort?: string;
}

// Units sold counts only orders that were actually paid (not pending, cancelled or refunded).
const SALES_JOIN = `LEFT JOIN (
    SELECT oi.product_id, SUM(oi.quantity)::int AS units
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.status IN ('PAID','PROCESSING','PACKED','SHIPPED','DELIVERED')
    GROUP BY oi.product_id
  ) sales ON sales.product_id = p.id`;

const SORTS: Record<string, string> = {
  newest: "p.created_at DESC, p.id DESC",
  oldest: "p.created_at ASC, p.id ASC",
  updated: "p.updated_at DESC NULLS LAST, p.id DESC",
  "price-asc": "p.price ASC, p.id ASC",
  "price-desc": "p.price DESC, p.id DESC",
  "stock-asc": "p.stock ASC, p.id ASC",
  "stock-desc": "p.stock DESC, p.id DESC",
  popularity: "COALESCE(sales.units, 0) DESC, p.id DESC",
  name: "LOWER(p.name) ASC, p.id ASC",
};

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

const buildWhere = (f: ProductListFilters) => {
  const conds: string[] = [];
  const values: any[] = [];
  const add = (sql: (n: number) => string, v: any) => {
    values.push(v);
    conds.push(sql(values.length));
  };
  if (f.q?.trim()) {
    add(
      (n) => `(p.name ILIKE $${n} OR p.sku ILIKE $${n} OR EXISTS (SELECT 1 FROM brands bq WHERE bq.id = p.brand_id AND bq.name ILIKE $${n}))`,
      `%${escapeLike(f.q.trim().slice(0, 100))}%`
    );
  }
  // Category filter includes all descendant categories.
  if (f.category) {
    add(
      (n) => `EXISTS (
        WITH RECURSIVE tree AS (SELECT id FROM categories WHERE id = $${n} UNION ALL SELECT c.id FROM categories c JOIN tree t ON c.parent_id = t.id)
        SELECT 1 FROM product_categories pc WHERE pc.product_id = p.id AND pc.category_id IN (SELECT id FROM tree))`,
      f.category
    );
  }
  if (f.brand) add((n) => `p.brand_id = $${n}`, f.brand);
  if (f.status && ["DRAFT", "ACTIVE", "INACTIVE"].includes(f.status)) add((n) => `p.status = $${n}`, f.status);
  if (f.featured !== undefined) add((n) => `p.is_featured = $${n}`, f.featured);
  if (f.minPrice !== undefined) add((n) => `p.price >= $${n}`, f.minPrice);
  if (f.maxPrice !== undefined) add((n) => `p.price <= $${n}`, f.maxPrice);
  if (f.stock === "out") conds.push("p.track_inventory AND p.stock <= 0");
  if (f.stock === "low") conds.push("p.track_inventory AND p.stock > 0 AND p.stock <= p.low_stock_threshold");
  if (f.stock === "in") conds.push("(NOT p.track_inventory OR p.stock > p.low_stock_threshold)");
  if (f.stock === "untracked") conds.push("NOT p.track_inventory");
  return { where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", values };
};

const DETAIL_COLUMNS = `
  p.id, p.name, p.slug, p.sku, p.price, p.compare_at_price, p.cost_price, p.stock, p.track_inventory,
  p.low_stock_threshold, p.status, p.is_featured, p.created_at, p.updated_at,
  b.id AS brand_id, b.name AS brand_name,
  img.image_url AS image, COALESCE(imgc.n, 0) AS image_count,
  COALESCE(cats.names, '') AS category_names,
  COALESCE(sales.units, 0) AS units_sold`;

const DETAIL_JOINS = `
  LEFT JOIN brands b ON b.id = p.brand_id
  LEFT JOIN LATERAL (SELECT pi.image_url FROM product_images pi WHERE pi.product_id = p.id
                     ORDER BY pi.is_primary DESC, pi.sort_order ASC, pi.id ASC LIMIT 1) img ON TRUE
  LEFT JOIN LATERAL (SELECT COUNT(*)::int AS n FROM product_images pi WHERE pi.product_id = p.id) imgc ON TRUE
  LEFT JOIN LATERAL (SELECT string_agg(c.name, ', ' ORDER BY c.name) AS names
                     FROM product_categories pc JOIN categories c ON c.id = pc.category_id
                     WHERE pc.product_id = p.id) cats ON TRUE`;

export const listProducts = async (f: ProductListFilters, page: number, limit: number) => {
  const { where, values } = buildWhere(f);
  const orderBy = SORTS[f.sort ?? ""] ?? SORTS.newest;
  const offset = (page - 1) * limit;

  // Page the ids first (cheap), then join images/categories/brand only for that page.
  const [rows, count] = await Promise.all([
    pool.query(
      `WITH page AS (
         SELECT p.id, ROW_NUMBER() OVER (ORDER BY ${orderBy}) AS rn
         FROM products p ${SALES_JOIN} ${where}
         ORDER BY ${orderBy}
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}
       )
       SELECT ${DETAIL_COLUMNS}
       FROM page JOIN products p ON p.id = page.id ${SALES_JOIN} ${DETAIL_JOINS}
       ORDER BY page.rn`,
      [...values, limit, offset]
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM products p ${where}`, values),
  ]);
  const total = count.rows[0].total as number;
  return { data: rows.rows, pagination: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) } };
};

// Spreadsheet apps execute cells starting with = + - @ as formulas; prefix them so exported
// product data can't carry formula injection.
const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const exportProductsCsv = async (f: ProductListFilters) => {
  const { where, values } = buildWhere(f);
  const orderBy = SORTS[f.sort ?? ""] ?? SORTS.newest;
  const result = await pool.query(
    `SELECT ${DETAIL_COLUMNS}, p.gst_rate, p.hsn_code
     FROM products p ${SALES_JOIN} ${DETAIL_JOINS} ${where}
     ORDER BY ${orderBy} LIMIT 5000`,
    values
  );
  const header = ["ID", "Name", "SKU", "Slug", "Brand", "Categories", "Selling Price", "MRP", "Cost Price", "GST %", "HSN", "Stock", "Inventory Tracked", "Status", "Featured", "Units Sold", "Created", "Updated"];
  const lines = result.rows.map((r) =>
    [r.id, r.name, r.sku, r.slug, r.brand_name, r.category_names, r.price, r.compare_at_price, r.cost_price, r.gst_rate, r.hsn_code, r.stock, r.track_inventory ? "Yes" : "No", r.status, r.is_featured ? "Yes" : "No", r.units_sold, r.created_at?.toISOString?.() ?? r.created_at, r.updated_at?.toISOString?.() ?? r.updated_at]
      .map(csvCell)
      .join(",")
  );
  return { csv: "﻿" + [header.join(","), ...lines].join("\r\n"), count: result.rows.length };
};

export const getProduct = async (productId: number) => {
  const [p, cats, imgs] = await Promise.all([
    pool.query(
      `SELECT p.*, b.name AS brand_name, COALESCE(m.min_quantity, 1) AS min_quantity
       FROM products p LEFT JOIN brands b ON b.id = p.brand_id LEFT JOIN product_moq m ON m.product_id = p.id
       WHERE p.id = $1`,
      [productId]
    ),
    pool.query("SELECT category_id FROM product_categories WHERE product_id=$1", [productId]),
    pool.query("SELECT id, image_url, alt_text, sort_order, is_primary FROM product_images WHERE product_id=$1 ORDER BY sort_order, id", [productId]),
  ]);
  if (p.rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Product not found");
  return { ...p.rows[0], category_ids: cats.rows.map((r) => r.category_id), images: imgs.rows };
};

const assertRefs = async (db: Queryable, brandId: number | null | undefined, categoryIds: number[]) => {
  if (brandId) {
    const b = await db.query("SELECT 1 FROM brands WHERE id=$1", [brandId]);
    if (b.rows.length === 0) throw new HttpError(422, "INVALID_BRAND", "Selected brand does not exist");
  }
  if (categoryIds.length) {
    const c = await db.query("SELECT COUNT(*)::int n FROM categories WHERE id = ANY($1::int[])", [categoryIds]);
    if (c.rows[0].n !== new Set(categoryIds).size) throw new HttpError(422, "INVALID_CATEGORY", "One or more categories do not exist");
  }
};

const logMovement = async (
  db: Queryable,
  m: { product_id: number; change: number; stock_after: number; reason: string; reference?: string | null; note?: string | null; user?: string | null }
) => {
  if (m.change === 0) return;
  await db.query(
    `INSERT INTO inventory_movements (product_id, change, stock_after, reason, reference, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [m.product_id, m.change, m.stock_after, m.reason, m.reference ?? null, m.note ?? null, m.user ?? null]
  );
};

const productParams = (v: any) => [
  v.name,
  v.slug || null,
  v.sku || null,
  v.short_description ?? null,
  v.description ?? null,
  v.brand_id ?? null,
  v.product_type ?? null,
  v.price,
  v.compare_at_price || null,
  v.cost_price ?? null,
  v.gst_rate ?? null,
  v.hsn_code || null,
  v.track_inventory,
  v.low_stock_threshold,
  v.status,
  v.is_featured,
  JSON.stringify(v.attributes ?? {}),
  v.seo_title ?? null,
  v.seo_description ?? null,
  v.category_ids?.[0] ?? null, // legacy single-category column kept in sync
];

const translateUnique = (err: unknown) => {
  if (isUniqueViolation(err)) {
    const c = (err as any).constraint ?? "";
    if (c.includes("slug")) return new HttpError(409, "DUPLICATE_SLUG", "Another product already uses this URL slug");
    if (c.includes("sku")) return new HttpError(409, "DUPLICATE_SKU", "Another product already uses this SKU");
  }
  return err;
};

// All three writers below finish their transaction (releasing the connection) before the audit
// log and the read-back, which use the shared pool — see withTransaction.
export const createProduct = async (userId: string, v: any) => {
  const productId = await withTransaction(async (client) => {
    await assertRefs(client, v.brand_id, v.category_ids);
    const r = await client.query(
      `INSERT INTO products (name, slug, sku, short_description, description, brand_id, product_type, price, compare_at_price,
         cost_price, gst_rate, hsn_code, track_inventory, low_stock_threshold, status, is_featured, attributes, seo_title,
         seo_description, category_id, stock)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING id, stock`,
      [...productParams(v), v.stock]
    );
    const productId = r.rows[0].id;
    if (v.category_ids.length) {
      await client.query(
        "INSERT INTO product_categories (product_id, category_id) SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING",
        [productId, [...new Set(v.category_ids)]]
      );
    }
    await logMovement(client, { product_id: productId, change: v.stock, stock_after: v.stock, reason: "INITIAL", user: userId });
    return productId as number;
  }).catch((err) => {
    throw translateUnique(err);
  });
  await recordAuditLog(userId, "CREATE", "product", productId, { name: v.name });
  return getProduct(productId);
};

export const updateProduct = async (userId: string, productId: number, v: any) => {
  await withTransaction(async (client) => {
    const cur = await client.query("SELECT stock FROM products WHERE id=$1 FOR UPDATE", [productId]);
    if (cur.rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Product not found");
    await assertRefs(client, v.brand_id, v.category_ids);

    await client.query(
      `UPDATE products SET name=$1, slug=COALESCE($2, slug), sku=$3, short_description=$4, description=$5, brand_id=$6,
         product_type=$7, price=$8, compare_at_price=$9, cost_price=$10, gst_rate=$11, hsn_code=$12, track_inventory=$13,
         low_stock_threshold=$14, status=$15, is_featured=$16, attributes=$17, seo_title=$18, seo_description=$19,
         category_id=$20, stock=$21, updated_at=NOW()
       WHERE id=$22`,
      [...productParams(v), v.stock, productId]
    );
    await client.query("DELETE FROM product_categories WHERE product_id=$1", [productId]);
    if (v.category_ids.length) {
      await client.query(
        "INSERT INTO product_categories (product_id, category_id) SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING",
        [productId, [...new Set(v.category_ids)]]
      );
    }
    // Stock edits made from the product form are recorded in the inventory ledger too.
    await logMovement(client, {
      product_id: productId,
      change: v.stock - cur.rows[0].stock,
      stock_after: v.stock,
      reason: "CORRECTION",
      note: "Edited on product form",
      user: userId,
    });
  }).catch((err) => {
    throw translateUnique(err);
  });
  await recordAuditLog(userId, "UPDATE", "product", productId);
  return getProduct(productId);
};

// Copies the catalog data, category links, images (same S3 objects — the image delete path only
// removes an S3 object once no row references it), bulk tiers and MOQ. The copy starts as a
// DRAFT with no SKU and zero stock so it can't go live or oversell by accident.
export const duplicateProduct = async (userId: string, productId: number) => {
  const newId = await withTransaction(async (client) => {
    const r = await client.query(
      `INSERT INTO products (name, short_description, description, brand_id, product_type, price, compare_at_price, cost_price,
         gst_rate, hsn_code, track_inventory, low_stock_threshold, status, is_featured, attributes, seo_title, seo_description,
         category_id, stock, sku)
       SELECT LEFT(name || ' (Copy)', 255), short_description, description, brand_id, product_type, price, compare_at_price, cost_price,
         gst_rate, hsn_code, track_inventory, low_stock_threshold, 'DRAFT', FALSE, attributes, seo_title, seo_description,
         category_id, 0, NULL
       FROM products WHERE id = $1
       RETURNING id`,
      [productId]
    );
    if (r.rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Product not found");
    const newId = r.rows[0].id;
    await client.query("INSERT INTO product_categories (product_id, category_id) SELECT $1, category_id FROM product_categories WHERE product_id=$2", [newId, productId]);
    await client.query(
      `INSERT INTO product_images (product_id, s3_key, image_url, alt_text, sort_order, is_primary)
       SELECT $1, s3_key, image_url, alt_text, sort_order, is_primary FROM product_images WHERE product_id=$2`,
      [newId, productId]
    );
    await client.query(
      "INSERT INTO product_bulk_pricing (product_id, min_quantity, price_per_unit, discount_percent) SELECT $1, min_quantity, price_per_unit, discount_percent FROM product_bulk_pricing WHERE product_id=$2",
      [newId, productId]
    );
    await client.query("INSERT INTO product_moq (product_id, min_quantity, moq_note) SELECT $1, min_quantity, moq_note FROM product_moq WHERE product_id=$2", [newId, productId]);
    return newId as number;
  });
  await recordAuditLog(userId, "DUPLICATE", "product", newId, { from: productId });
  return getProduct(newId);
};

// Products referenced by orders are deactivated rather than deleted to keep order history intact.
const deleteOrDeactivate = async (db: Queryable, ids: number[]) => {
  const ordered = await db.query("SELECT DISTINCT product_id FROM order_items WHERE product_id = ANY($1::int[])", [ids]);
  const keep = new Set<number>(ordered.rows.map((r) => r.product_id));
  const toDelete = ids.filter((i) => !keep.has(i));
  const toDeactivate = ids.filter((i) => keep.has(i));
  const del = toDelete.length ? await db.query("DELETE FROM products WHERE id = ANY($1::int[]) RETURNING id", [toDelete]) : { rows: [] };
  const deact = toDeactivate.length
    ? await db.query("UPDATE products SET status='INACTIVE', updated_at=NOW() WHERE id = ANY($1::int[]) RETURNING id", [toDeactivate])
    : { rows: [] };
  return { deleted: del.rows.length, deactivated: deact.rows.length };
};

export const deleteProduct = async (userId: string, productId: number) => {
  const result = await deleteOrDeactivate(pool, [productId]);
  if (result.deleted + result.deactivated === 0) throw new HttpError(404, "NOT_FOUND", "Product not found");
  await recordAuditLog(userId, result.deleted ? "DELETE" : "DEACTIVATE", "product", productId);
  return result;
};

export const bulkAction = async (userId: string, ids: number[], action: string) => {
  const unique = [...new Set(ids)];
  let result: Record<string, number>;
  if (action === "delete") {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      result = await deleteOrDeactivate(client, unique);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } else {
    const set: Record<string, string> = {
      activate: "status='ACTIVE'",
      deactivate: "status='INACTIVE'",
      draft: "status='DRAFT'",
      feature: "is_featured=TRUE",
      unfeature: "is_featured=FALSE",
    };
    const r = await pool.query(`UPDATE products SET ${set[action]}, updated_at=NOW() WHERE id = ANY($1::int[]) RETURNING id`, [unique]);
    result = { updated: r.rows.length };
  }
  await recordAuditLog(userId, `BULK_${action.toUpperCase()}`, "product", undefined, { ids: unique, ...result });
  return result;
};

export { logMovement };

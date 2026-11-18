import { pool } from "../database/db";
import { HttpError, isUniqueViolation } from "../utils/httpError";
import { recordAuditLog } from "../utils/auditLog";
import { generatePresignedUpload, publicUrlForOwnedKey, UploadFolder } from "../utils/s3";

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160) || "item";

const resolveImage = (folder: UploadFolder, key: string | null | undefined, remove: boolean | undefined, current: string | null) => {
  if (remove) return null;
  if (!key) return current;
  const url = publicUrlForOwnedKey(folder, key);
  if (!url) throw new HttpError(422, "INVALID_IMAGE", "Image must be uploaded through the admin uploader");
  return url;
};

export const presignAsset = async (folder: "categories" | "brands", contentType: string) =>
  generatePresignedUpload({ folder, entityId: "assets", contentType });

// ── Categories ────────────────────────────────────────────────────────────

// Flat list with parent ids and counts; the UI builds the tree. product_count counts direct
// links; active_product_count only storefront-visible products.
export const listCategories = async () => {
  const r = await pool.query(`
    SELECT c.id, c.name, c.slug, c.parent_id, c.description, c.image_url, c.is_active, c.seo_title, c.seo_description,
           c.sort_order, c.created_at,
           COUNT(DISTINCT pc.product_id)::int AS product_count,
           COUNT(DISTINCT pc.product_id) FILTER (WHERE p.is_active)::int AS active_product_count,
           (SELECT COUNT(*)::int FROM categories ch WHERE ch.parent_id = c.id) AS child_count
    FROM categories c
    LEFT JOIN product_categories pc ON pc.category_id = c.id
    LEFT JOIN products p ON p.id = pc.product_id
    GROUP BY c.id
    ORDER BY c.sort_order, LOWER(c.name)`);
  return r.rows;
};

const assertParent = async (categoryId: number | null, parentId: number | null | undefined) => {
  if (!parentId) return;
  if (categoryId && parentId === categoryId) throw new HttpError(422, "INVALID_PARENT", "A category cannot be its own parent");
  const exists = await pool.query("SELECT 1 FROM categories WHERE id=$1", [parentId]);
  if (exists.rows.length === 0) throw new HttpError(422, "INVALID_PARENT", "Parent category does not exist");
  if (categoryId) {
    // Reject moving a category underneath one of its own descendants (would create a cycle).
    const cycle = await pool.query(
      `WITH RECURSIVE d AS (SELECT id FROM categories WHERE parent_id = $1 UNION ALL SELECT c.id FROM categories c JOIN d ON c.parent_id = d.id)
       SELECT 1 FROM d WHERE id = $2`,
      [categoryId, parentId]
    );
    if (cycle.rows.length) throw new HttpError(422, "INVALID_PARENT", "A category cannot be moved under its own subcategory");
  }
};

const categoryUnique = (err: unknown) =>
  isUniqueViolation(err) ? new HttpError(409, "DUPLICATE_SLUG", "Another category already uses this slug") : err;

export const createCategory = async (userId: string, v: any) => {
  await assertParent(null, v.parent_id);
  const image = resolveImage("categories", v.image_key, false, null);
  try {
    const r = await pool.query(
      `INSERT INTO categories (name, slug, parent_id, description, image_url, is_active, seo_title, seo_description, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [v.name, v.slug || slugify(v.name), v.parent_id ?? null, v.description ?? null, image, v.is_active, v.seo_title ?? null, v.seo_description ?? null, v.sort_order]
    );
    await recordAuditLog(userId, "CREATE", "category", r.rows[0].id, { name: v.name });
    return r.rows[0];
  } catch (err) {
    throw categoryUnique(err);
  }
};

export const updateCategory = async (userId: string, id: number, v: any) => {
  const cur = await pool.query("SELECT image_url FROM categories WHERE id=$1", [id]);
  if (cur.rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Category not found");
  await assertParent(id, v.parent_id);
  const image = resolveImage("categories", v.image_key, v.remove_image, cur.rows[0].image_url);
  try {
    const r = await pool.query(
      `UPDATE categories SET name=$1, slug=$2, parent_id=$3, description=$4, image_url=$5, is_active=$6, seo_title=$7,
         seo_description=$8, sort_order=$9, updated_at=NOW()
       WHERE id=$10 RETURNING *`,
      [v.name, v.slug || slugify(v.name), v.parent_id ?? null, v.description ?? null, image, v.is_active, v.seo_title ?? null, v.seo_description ?? null, v.sort_order, id]
    );
    await recordAuditLog(userId, "UPDATE", "category", id);
    return r.rows[0];
  } catch (err) {
    throw categoryUnique(err);
  }
};

export const deleteCategory = async (userId: string, id: number) => {
  const [children, products] = await Promise.all([
    pool.query("SELECT COUNT(*)::int n FROM categories WHERE parent_id=$1", [id]),
    pool.query("SELECT COUNT(*)::int n FROM product_categories WHERE category_id=$1", [id]),
  ]);
  if (children.rows[0].n > 0) throw new HttpError(409, "HAS_CHILDREN", `Move or delete its ${children.rows[0].n} subcategories first`);
  if (products.rows[0].n > 0) {
    throw new HttpError(409, "HAS_PRODUCTS", `${products.rows[0].n} products are in this category. Reassign them or deactivate the category instead.`);
  }
  const r = await pool.query("DELETE FROM categories WHERE id=$1 RETURNING id", [id]);
  if (r.rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Category not found");
  await recordAuditLog(userId, "DELETE", "category", id);
};

// ── Brands ────────────────────────────────────────────────────────────────

export const listBrands = async (q?: string) => {
  const values: any[] = [];
  let where = "";
  if (q?.trim()) {
    values.push(`%${q.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    where = "WHERE b.name ILIKE $1";
  }
  const r = await pool.query(
    `SELECT b.*, COUNT(p.id)::int AS product_count
     FROM brands b LEFT JOIN products p ON p.brand_id = b.id
     ${where} GROUP BY b.id ORDER BY LOWER(b.name)`,
    values
  );
  return r.rows;
};

const brandUnique = (err: unknown) =>
  isUniqueViolation(err) ? new HttpError(409, "DUPLICATE_BRAND", "A brand with this name or slug already exists") : err;

export const createBrand = async (userId: string, v: any) => {
  const logo = resolveImage("brands", v.logo_key, false, null);
  try {
    const r = await pool.query(
      "INSERT INTO brands (name, slug, description, logo_url, is_active) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [v.name, v.slug || slugify(v.name), v.description ?? null, logo, v.is_active]
    );
    await recordAuditLog(userId, "CREATE", "brand", r.rows[0].id, { name: v.name });
    return r.rows[0];
  } catch (err) {
    throw brandUnique(err);
  }
};

export const updateBrand = async (userId: string, id: number, v: any) => {
  const cur = await pool.query("SELECT logo_url FROM brands WHERE id=$1", [id]);
  if (cur.rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Brand not found");
  const logo = resolveImage("brands", v.logo_key, v.remove_logo, cur.rows[0].logo_url);
  try {
    const r = await pool.query(
      "UPDATE brands SET name=$1, slug=$2, description=$3, logo_url=$4, is_active=$5, updated_at=NOW() WHERE id=$6 RETURNING *",
      [v.name, v.slug || slugify(v.name), v.description ?? null, logo, v.is_active, id]
    );
    await recordAuditLog(userId, "UPDATE", "brand", id);
    return r.rows[0];
  } catch (err) {
    throw brandUnique(err);
  }
};

export const deleteBrand = async (userId: string, id: number) => {
  const used = await pool.query("SELECT COUNT(*)::int n FROM products WHERE brand_id=$1", [id]);
  if (used.rows[0].n > 0) {
    throw new HttpError(409, "HAS_PRODUCTS", `${used.rows[0].n} products use this brand. Reassign them or deactivate the brand instead.`);
  }
  const r = await pool.query("DELETE FROM brands WHERE id=$1 RETURNING id", [id]);
  if (r.rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Brand not found");
  await recordAuditLog(userId, "DELETE", "brand", id);
};

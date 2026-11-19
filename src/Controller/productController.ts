import { Request, Response } from "express";
import { pool } from "../database/db";

import path from "path";
import fs from "fs";
import * as XLSX from "xlsx";
import { isStaff } from "../middleware/auth";
import { pagination } from "../middleware/validate";

// Whitelisted sort orders — user input never reaches the SQL text directly.
const SORTS: Record<string, string> = {
  newest: "p.created_at DESC, p.id DESC",
  "price-asc": "p.price ASC, p.id ASC",
  "price-desc": "p.price DESC, p.id DESC",
  name: "p.name ASC, p.id ASC",
};

// Only the columns listing cards need (no full descriptions), plus the primary image.
const LIST_COLUMNS = `p.id, p.sku, p.name, LEFT(p.description, 200) AS description, p.price, p.compare_at_price,
  p.stock, p.track_inventory, p.is_active, p.category_id, p.created_at, p.updated_at,
  img.image_url AS image,
  (NOT p.track_inventory OR p.stock > 0) AS in_stock`;

const PRIMARY_IMAGE_JOIN = `LEFT JOIN LATERAL (
    SELECT pi.image_url FROM product_images pi WHERE pi.product_id = p.id
    ORDER BY pi.is_primary DESC, pi.sort_order ASC, pi.id ASC LIMIT 1
  ) img ON TRUE`;

// Escapes LIKE wildcards (and the escape char) so search text is matched literally.
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

// GET all products (public). Inactive products are hidden unless a staff user asks for them.
export const getProducts = async (req: Request, res: Response) => {
  try {
    const { page, limit } = pagination(req.query, 10, 50);
    const offset = (page - 1) * limit;
    const { category, minPrice, maxPrice, inStock, q, sort, includeInactive } = req.query;

    const conditions: string[] = [];
    const values: any[] = [];

    if (!(includeInactive === "true" && isStaff(req))) {
      conditions.push("p.is_active = TRUE");
    }

    // Category filter via EXISTS instead of JOIN + DISTINCT: no duplicate rows, and the
    // planner can use the product_categories(category_id) index.
    if (category) {
      const ids = String(category)
        .split(",")
        .map((c) => parseInt(c, 10))
        .filter((n) => Number.isInteger(n) && n > 0);
      if (ids.length > 0) {
        values.push(ids);
        conditions.push(
          `EXISTS (SELECT 1 FROM product_categories pc WHERE pc.product_id = p.id AND pc.category_id = ANY($${values.length}::int[]))`
        );
      }
    }

    const min = Number(minPrice);
    if (minPrice !== undefined && minPrice !== "" && Number.isFinite(min)) {
      values.push(min);
      conditions.push(`p.price >= $${values.length}`);
    }
    const max = Number(maxPrice);
    if (maxPrice !== undefined && maxPrice !== "" && Number.isFinite(max)) {
      values.push(max);
      conditions.push(`p.price <= $${values.length}`);
    }

    if (inStock === "true") {
      conditions.push("(NOT p.track_inventory OR p.stock > 0)");
    }

    if (typeof q === "string" && q.trim()) {
      values.push(`%${escapeLike(q.trim().slice(0, 100))}%`);
      conditions.push(`(p.name ILIKE $${values.length} OR p.sku ILIKE $${values.length})`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const orderBy = SORTS[String(sort)] ?? SORTS.newest;

    const [result, totalResult] = await Promise.all([
      pool.query(
        `SELECT ${LIST_COLUMNS} FROM products p ${PRIMARY_IMAGE_JOIN} ${where}
         ORDER BY ${orderBy} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset]
      ),
      pool.query(`SELECT COUNT(*)::int AS count FROM products p ${where}`, values),
    ]);
    const total = totalResult.rows[0].count as number;

    res.json({
      success: true,
      data: result.rows,
      pagination: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    console.error("getProducts error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch products", code: "SERVER_ERROR" });
  }
};

export const getSingleProduct = async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(404).json({ success: false, message: "Product not found", code: "NOT_FOUND" });
    }

    const [productResult, imagesResult, tiersResult] = await Promise.all([
      pool.query(
        // Explicit public columns only: admin-only fields (cost_price, gst/hsn, etc.) never leave the server.
        `SELECT p.id, p.name, p.slug, p.sku, p.description, p.short_description, p.price, p.compare_at_price,
                p.stock, p.track_inventory, p.is_active, p.is_featured, p.category_id, p.brand_id, p.attributes,
                p.seo_title, p.seo_description, p.updated_at, b.name AS brand_name,
                COALESCE(m.min_quantity, 1) AS min_quantity, m.moq_note,
                (NOT p.track_inventory OR p.stock > 0) AS in_stock
         FROM products p LEFT JOIN product_moq m ON m.product_id = p.id LEFT JOIN brands b ON b.id = p.brand_id
         WHERE p.id = $1`,
        [id]
      ),
      pool.query(
        "SELECT image_url, alt_text FROM product_images WHERE product_id=$1 ORDER BY is_primary DESC, sort_order ASC, id ASC",
        [id]
      ),
      pool.query(
        "SELECT min_quantity, price_per_unit, discount_percent FROM product_bulk_pricing WHERE product_id=$1 ORDER BY min_quantity",
        [id]
      ),
    ]);

    const product = productResult.rows[0];
    // Inactive products 404 for the public, but staff can still open them in the admin editor.
    if (!product || (!product.is_active && !isStaff(req))) {
      return res.status(404).json({ success: false, message: "Product not found", code: "NOT_FOUND" });
    }

    res.json({
      success: true,
      message: "Product found",
      data: {
        ...product,
        // stock is only meaningful when inventory is tracked; null signals "made to order".
        stock_available: product.track_inventory ? Math.max(0, product.stock) : null,
        images: imagesResult.rows.map((r) => r.image_url),
        image_details: imagesResult.rows,
        bulk_pricing: tiersResult.rows,
      },
    });
  } catch (error) {
    console.error("getSingleProduct error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch product", code: "SERVER_ERROR" });
  }
};

export const createProductByLookingAtSheet = async (req: Request, res: Response) => {
  const client = await pool.connect();

  try {
    const filePath = path.join(__dirname, "../../khazanagiftigsheets.xlsx");

    if (!fs.existsSync(filePath)) {
      return res.status(400).json({ error: "Sheet file not found" });
    }

    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const rawData: any[] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

    // ─── 1. Detect duplicates in one pass ──────────────────────────────────
    const seen = new Set<string>();
    const duplicateSet = new Set<string>();

    for (const row of rawData) {
      const sku = row["SKU"]?.toLowerCase().trim();
      if (!sku) continue;
      seen.has(sku) ? duplicateSet.add(sku) : seen.add(sku);
    }

    const duplicates = Array.from(duplicateSet);

    // ─── 2. Split into valid / invalid in one pass ──────────────────────────
    const validData: any[] = [];
    const annotatedData = rawData.map((row) => {
      const sku = row["SKU"]?.toLowerCase().trim();

      if (!sku)             return { ...row, Error: "Missing SKU",   Action: "Fix Required" };
      if (duplicateSet.has(sku)) return { ...row, Error: "Duplicate SKU", Action: "Fix Required" };

      validData.push(row);
      return { ...row, Error: "", Action: "OK" };
    });

    // ─── 3. Early exit if nothing valid ────────────────────────────────────
    if (validData.length === 0) {
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(annotatedData), sheetName, true);
      XLSX.writeFile(workbook, filePath);

      return res.status(400).json({
        message: "No valid rows to import",
        duplicates,
        duplicateCount: duplicates.length,
        totalRows: rawData.length,
        validRows: 0,
      });
    }

    await client.query("BEGIN");

    // ─── 4. Bulk UPSERT products ────────────────────────────────────────────
    const productValues: any[] = [];
    const productStrings: string[] = [];

    validData.forEach((row, i) => {
      const base = i * 4;
      productStrings.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
      productValues.push(row["SKU"], row["Name"], row["Description"], row["Regular price"]);
    });

    await client.query(
      `INSERT INTO products (sku, name, description, price)
       VALUES ${productStrings.join(",")}
       ON CONFLICT (sku) DO UPDATE SET
         name        = EXCLUDED.name,
         description = EXCLUDED.description,
         price       = EXCLUDED.price`,
      productValues
    );

    // ─── 5. Fetch all inserted/updated IDs in one query ────────────────────
    const skuList = validData.map((r) => r["SKU"]);

    const { rows: productRows } = await client.query<{ id: number; sku: string }>(
      `SELECT id, sku FROM products WHERE sku = ANY($1)`,
      [skuList]
    );

    const skuToId = new Map<string, number>(productRows.map((r) => [r.sku, r.id]));
    const productIds = productRows.map((r) => r.id);

    // ─── 6. Load existing categories ───────────────────────────────────────
    const { rows: categoryRows } = await client.query<{ id: number; name: string }>(
      `SELECT id, name FROM categories`
    );
    const categoryMap = new Map<string, number>(
      categoryRows.map((c) => [c.name.toLowerCase(), c.id])
    );

    // ─── 7. Collect all unique new category names needed ───────────────────
    const allCategoryNames = new Set<string>();

    for (const row of validData) {
      if (!row["Categories"]) continue;
      for (const cat of row["Categories"].split(",")) {
        const name = cat.trim().toLowerCase();
        if (name && !categoryMap.has(name)) allCategoryNames.add(name);
      }
    }

    // ─── 8. Batch insert new categories in ONE query ────────────────────────
    if (allCategoryNames.size > 0) {
      const newCatNames = Array.from(allCategoryNames);
      const catStrings = newCatNames.map((_, i) => `($${i + 1})`);

      const { rows: newCatRows } = await client.query<{ id: number; name: string }>(
        `INSERT INTO categories (name)
         VALUES ${catStrings.join(",")}
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, name`,
        newCatNames
      );

      // Merge new categories into the map
      for (const cat of newCatRows) categoryMap.set(cat.name.toLowerCase(), cat.id);
    }

    // ─── 9. Build all product↔category mappings ─────────────────────────────
    const mappingValues: any[] = [];
    const mappingStrings: string[] = [];
    let counter = 1;

    for (const row of validData) {
      const productId = skuToId.get(row["SKU"]);
      if (!row["Categories"] || !productId) continue;

      for (const cat of row["Categories"].split(",")) {
        const categoryId = categoryMap.get(cat.trim().toLowerCase());
        if (!categoryId) continue;

        mappingStrings.push(`($${counter++}, $${counter++})`);
        mappingValues.push(productId, categoryId);
      }
    }

    // ─── 10. Replace category mappings atomically ───────────────────────────
    if (productIds.length > 0) {
      await client.query(
        `DELETE FROM product_categories WHERE product_id = ANY($1)`,
        [productIds]
      );
    }

    if (mappingStrings.length > 0) {
      await client.query(
        `INSERT INTO product_categories (product_id, category_id)
         VALUES ${mappingStrings.join(",")}
         ON CONFLICT DO NOTHING`,
        mappingValues
      );
    }

    await client.query("COMMIT");

    // ─── 11. Write back to Excel (annotated + IDs) ─────────────────────────
    const dataForExcel = annotatedData.map((row) => {
      const id = skuToId.get(row["SKU"]);
      return id !== undefined ? { ...row, id } : row;
    });

    workbook.Sheets[sheetName] = XLSX.utils.json_to_sheet(dataForExcel);
    XLSX.writeFile(workbook, filePath);

    // ─── 12. Response ───────────────────────────────────────────────────────
    const baseResponse = {
      importedCount: productIds.length,
      totalRows: rawData.length,
      validRows: validData.length,
    };

    return duplicates.length > 0
      ? res.status(200).json({
          message: "Import completed — some duplicate SKUs were skipped",
          ...baseResponse,
          duplicates,
          duplicateCount: duplicates.length,
        })
      : res.status(200).json({
          message: "Bulk SKU import successful",
          ...baseResponse,
        });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Import failed" });
  } finally {
    client.release();
  }
};
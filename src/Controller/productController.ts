import { Request, Response } from "express";
import { pool } from "../database/db";

import path from "path";
import fs from "fs";
import * as XLSX from "xlsx";
// GET all products
export const getProducts = async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, parseInt(req.query.limit as string) || 10);
    const offset = (page - 1) * limit;

    const { category, minPrice, maxPrice, inStock } = req.query;

    let query = `
      SELECT DISTINCT p.* 
      FROM products p
    `;

    let countQuery = `
      SELECT COUNT(DISTINCT p.id) 
      FROM products p
    `;

    let conditions: string[] = [];
    let values: any[] = [];

    // 👉 CATEGORY FILTER (if using mapping table)
    if (category) {
      query += ` JOIN product_categories pc ON pc.product_id = p.id`;
      countQuery += ` JOIN product_categories pc ON pc.product_id = p.id`;

      const categoryArray = (category as string).split(",");
      conditions.push(`pc.category_id = ANY($${values.length + 1})`);
      values.push(categoryArray);
    }

    // 👉 PRICE RANGE
    if (minPrice) {
      conditions.push(`p.price >= $${values.length + 1}`);
      values.push(minPrice);
    }

    if (maxPrice) {
      conditions.push(`p.price <= $${values.length + 1}`);
      values.push(maxPrice);
    }

    // // 👉 STOCK FILTER
    // if (inStock === "true") {
    //   conditions.push(`p.stock > 0`);
    // }

    // 👉 APPLY CONDITIONS
    if (conditions.length > 0) {
      const whereClause = ` WHERE ` + conditions.join(" AND ");
      query += whereClause;
      countQuery += whereClause;
    }

    // 👉 FINAL QUERY
    query += `
      ORDER BY p.created_at DESC
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `;

    const finalValues = [...values, limit, offset];

    const result = await pool.query(query, finalValues);

    // 👉 COUNT
    const totalResult = await pool.query(countQuery, values);
    const total = parseInt(totalResult.rows[0].count);

    res.json({
      data: result.rows,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch products" });
  }
};

export const getSingleProduct = async (req: Request, res: Response) => {
  try {
    const id = req.params.id;

    const result = await pool.query(
      `SELECT 
        p.*,
        COALESCE(
          JSON_AGG(pi.image_url) FILTER (WHERE pi.image_url IS NOT NULL), 
          '[]'
        ) AS images
      FROM products p
      LEFT JOIN product_images pi ON pi.product_id = p.id
      WHERE p.id = $1
      GROUP BY p.id`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "Product not found",
      });
    }

    res.json({
      data: result.rows[0],
      message: "Product found",
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch product" });
  }
};

// CREATE product
export const createProduct = async (req: Request, res: Response) => {
  const { name, description, price, stock, category_id } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO products (name, description, price, stock, category_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, description, price, stock, category_id]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: "Failed to create product" });
  }
};

// UPDATE product
export const updateProduct = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, description, price, stock, category_id } = req.body;

  try {
    const result = await pool.query(
      `UPDATE products 
       SET name=$1, description=$2, price=$3, stock=$4, category_id=$5, updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      [name, description, price, stock, category_id, id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: "Failed to update product" });
  }
};

// DELETE product
export const deleteProduct = async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    await pool.query("DELETE FROM products WHERE id=$1", [id]);
    res.json({ message: "Product deleted" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete product" });
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
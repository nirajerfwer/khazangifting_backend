import { Request, Response } from "express";
import { pool } from "../database/db";

// GET all categories (public). Same array shape as before, plus slug/parent_id for navigation
// and description/SEO fields/updated_at for storefront metadata and sitemap lastmod.
// Inactive categories are hidden from shoppers; product_count only counts visible products.
// Admin CRUD lives in services/adminCatalogService.
export const getCategorys = async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT cat.name, cat.id, cat.slug, cat.parent_id, cat.image_url,
             cat.description, cat.seo_title, cat.seo_description, cat.updated_at,
             COUNT(p.id) AS product_count
      FROM categories AS cat
      LEFT JOIN product_categories AS pc ON cat.id = pc.category_id
      LEFT JOIN products AS p ON p.id = pc.product_id AND p.is_active = TRUE
      WHERE cat.is_active = TRUE
      GROUP BY cat.id
      ORDER BY cat.sort_order, cat.name;`);
    res.json(result.rows);
  } catch (error) {
    console.error("getCategorys error:", error);
    res.status(500).json({ error: "Failed to fetch categories" });
  }
};

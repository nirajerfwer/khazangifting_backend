import { Request, Response } from "express";
import { pool } from "../database/db";

const getOrCreateWishlistId = async (userId: string) => {
  const existing = await pool.query("SELECT id FROM wishlists WHERE user_id = $1", [userId]);
  if (existing.rows.length > 0) return existing.rows[0].id;

  const created = await pool.query("INSERT INTO wishlists (user_id) VALUES ($1) RETURNING id", [userId]);
  return created.rows[0].id;
};

export const addToWishlist = async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const { product_id } = req.body;

  try {
    const product = await pool.query("SELECT id FROM products WHERE id=$1", [product_id]);
    if (product.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found", code: "NOT_FOUND" });
    }

    const wishlistId = await getOrCreateWishlistId(userId);

    const result = await pool.query(
      `INSERT INTO wishlist_items (wishlist_id, product_id)
       VALUES ($1, $2)
       ON CONFLICT (wishlist_id, product_id) DO NOTHING
       RETURNING *`,
      [wishlistId, product_id]
    );

    res.json({ success: true, message: "Added to wishlist", data: result.rows[0] || null });
  } catch (error) {
    console.error("addToWishlist error:", error);
    res.status(500).json({ success: false, message: "Failed to add to wishlist", code: "SERVER_ERROR" });
  }
};

export const getWishlist = async (req: Request, res: Response) => {
  const userId = req.user!.sub;

  try {
    const result = await pool.query(
      `SELECT wi.id as wishlist_item_id, p.id as product_id, p.name, p.description, p.price, p.stock, wi.created_at
       FROM wishlists w
       JOIN wishlist_items wi ON w.id = wi.wishlist_id
       JOIN products p ON p.id = wi.product_id
       WHERE w.user_id = $1
       ORDER BY wi.created_at DESC`,
      [userId]
    );

    res.json({ success: true, data: { count: result.rows.length, items: result.rows } });
  } catch (error) {
    console.error("getWishlist error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch wishlist", code: "SERVER_ERROR" });
  }
};

export const removeFromWishlist = async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const { wishlist_item_id } = req.params;

  try {
    const result = await pool.query(
      `DELETE FROM wishlist_items
       WHERE id = $1
       AND wishlist_id = (SELECT id FROM wishlists WHERE user_id = $2)
       RETURNING *`,
      [wishlist_item_id, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Item not found", code: "NOT_FOUND" });
    }

    res.json({ success: true, message: "Item removed from wishlist", data: result.rows[0] });
  } catch (error) {
    console.error("removeFromWishlist error:", error);
    res.status(500).json({ success: false, message: "Failed to remove item", code: "SERVER_ERROR" });
  }
};

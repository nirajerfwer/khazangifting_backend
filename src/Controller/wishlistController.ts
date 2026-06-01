import { Request, Response } from "express";
import { pool } from "../database/db";

export const addToWishlist = async (req: Request, res: Response) => {
  const { user_id, product_id } = req.body;
  //TODO user_id will get from backend
  try {
    // 1. Get or create wishlist
    let wishlist = await pool.query(
      "SELECT * FROM wishlists WHERE user_id = $1",
      [user_id]
    );

    if (wishlist.rows.length === 0) {
      wishlist = await pool.query(
        "INSERT INTO wishlists (user_id) VALUES ($1) RETURNING *",
        [user_id]
      );
    }

    const wishlist_id = wishlist.rows[0].id;

    // 2. Insert item (ignore duplicates)
    const result = await pool.query(
      `
      INSERT INTO wishlist_items (wishlist_id, product_id)
      VALUES ($1, $2)
      ON CONFLICT (wishlist_id, product_id) DO NOTHING
      RETURNING *;
      `,
      [wishlist_id, product_id]
    );

    res.json({
      message: "Added to wishlist",
      data: result.rows[0] || null,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to add to wishlist" });
  }
};

export const getWishlist = async (req: Request, res: Response) => {
  const { user_id } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT 
        wi.id as wishlist_item_id,
        p.id as product_id,
        p.name,
        p.description,
        p.price,
        p.stock,
        wi.created_at
      FROM wishlists w
      JOIN wishlist_items wi ON w.id = wi.wishlist_id
      JOIN products p ON p.id = wi.product_id
      WHERE w.user_id = $1
      ORDER BY wi.created_at DESC
      `,
      [user_id]
    );

    res.json({
      count: result.rows.length,
      items: result.rows,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch wishlist" });
  }
};

export const removeFromWishlist = async (req: Request, res: Response) => {
  const { wishlist_item_id } = req.params;
  const { user_id } = req.body;

  try {
    const result = await pool.query(
      `
      DELETE FROM wishlist_items
      WHERE id = $1
      AND wishlist_id = (
        SELECT id FROM wishlists WHERE user_id = $2
      )
      RETURNING *
      `,
      [wishlist_item_id, user_id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Item not found or unauthorized" });
    }

    res.json({
      message: "Item removed from wishlist",
      data: result.rows[0],
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to remove item" });
  }
};
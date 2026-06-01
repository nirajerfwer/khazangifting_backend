import { Request, Response } from "express";
import { pool } from "../database/db";

export const addToCart = async (req: Request, res: Response) => {
  const { user_id, product_id, quantity } = req.body;
  // will get user_id from backend...
  
  try {
    // 1. Get or create cart
    let cart = await pool.query(
      "SELECT * FROM carts WHERE user_id = $1",
      [user_id]
    );

    if (cart.rows.length === 0) {
      cart = await pool.query(
        "INSERT INTO carts (user_id) VALUES ($1) RETURNING *",
        [user_id]
      );
    }

    const cart_id = cart.rows[0].id;

    // 2. Insert or update cart item
    const result = await pool.query(
      `
      INSERT INTO cart_items (cart_id, product_id, quantity)
      VALUES ($1, $2, $3)
      ON CONFLICT (cart_id, product_id)
      DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity,
                    updated_at = NOW()
      RETURNING *;
      `,
      [cart_id, product_id, quantity || 1]
    );

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: "Failed to add to cart" });
  }
};

export const getCart = async (req: any, res: any) => {
  const { user_id } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT 
        ci.id,
        ci.quantity,
        p.id as product_id,
        p.name,
        p.price,
        p.description,
        (ci.quantity * p.price) as total_price
      FROM carts c
      JOIN cart_items ci ON c.id = ci.cart_id
      JOIN products p ON p.id = ci.product_id
      WHERE c.user_id = $1
      ORDER BY ci.created_at DESC
      `,
      [user_id]
    );

    const totalAmount = result.rows.reduce(
      (sum, item) => sum + Number(item.total_price),
      0
    );

    res.json({
      items: result.rows,
      totalAmount,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch cart" });
  }
};

export const removeFromCart = async (req: any, res: any) => {
  const { cart_item_id } = req.params;

  try {
    await pool.query(
      `DELETE FROM cart_items WHERE id = $1`,
      [cart_item_id]
    );

    res.json({ message: "Item removed from cart" });
  } catch (error) {
    res.status(500).json({ error: "Failed to remove item" });
  }
};

export const updateCartQuantity = async (req: any, res: any) => {
  const { cart_item_id } = req.params;
  const { quantity } = req.body;

  if (quantity <= 0) {
    return res.status(400).json({ error: "Quantity must be > 0" });
  }

  try {
    const result = await pool.query(
      `
      UPDATE cart_items
      SET quantity = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING *
      `,
      [quantity, cart_item_id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: "Failed to update quantity" });
  }
};

export const moveWishlistToCart = async (req: any, res: any) => {
  const { user_id, product_id } = req.body;

  try {
    // 1. Get or create cart
    let cart = await pool.query(
      "SELECT * FROM carts WHERE user_id = $1",
      [user_id]
    );

    if (cart.rows.length === 0) {
      cart = await pool.query(
        "INSERT INTO carts (user_id) VALUES ($1) RETURNING *",
        [user_id]
      );
    }

    const cart_id = cart.rows[0].id;

    // 2. Add to cart
    await pool.query(
      `
      INSERT INTO cart_items (cart_id, product_id, quantity)
      VALUES ($1, $2, 1)
      ON CONFLICT (cart_id, product_id)
      DO UPDATE SET quantity = cart_items.quantity + 1,
                    updated_at = NOW()
      `,
      [cart_id, product_id]
    );

    // 3. Remove from wishlist
    await pool.query(
      `
      DELETE FROM wishlist_items
      WHERE product_id = $1
      AND wishlist_id = (
        SELECT id FROM wishlists WHERE user_id = $2
      )
      `,
      [product_id, user_id]
    );

    res.json({ message: "Moved to cart successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to move item" });
  }
};
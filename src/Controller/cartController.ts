import { Request, Response } from "express";
import { pool } from "../database/db";

const getOrCreateCartId = async (userId: string) => {
  const existing = await pool.query("SELECT id FROM carts WHERE user_id = $1", [userId]);
  if (existing.rows.length > 0) return existing.rows[0].id;

  const created = await pool.query("INSERT INTO carts (user_id) VALUES ($1) RETURNING id", [userId]);
  return created.rows[0].id;
};

export const addToCart = async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const { product_id, quantity } = req.body;

  const qty = Number(quantity) || 1;
  if (qty <= 0) {
    return res.status(400).json({ success: false, message: "Quantity must be > 0", code: "INVALID_QUANTITY" });
  }

  try {
    const product = await pool.query("SELECT id FROM products WHERE id=$1", [product_id]);
    if (product.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found", code: "NOT_FOUND" });
    }

    const cartId = await getOrCreateCartId(userId);

    const result = await pool.query(
      `INSERT INTO cart_items (cart_id, product_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (cart_id, product_id)
       DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity, updated_at = NOW()
       RETURNING *`,
      [cartId, product_id, qty]
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("addToCart error:", error);
    res.status(500).json({ success: false, message: "Failed to add to cart", code: "SERVER_ERROR" });
  }
};

export const getCart = async (req: Request, res: Response) => {
  const userId = req.user!.sub;

  try {
    const result = await pool.query(
      `SELECT ci.id, ci.quantity, p.id as product_id, p.name, p.price, p.stock,
              (ci.quantity * p.price) as total_price
       FROM carts c
       JOIN cart_items ci ON c.id = ci.cart_id
       JOIN products p ON p.id = ci.product_id
       WHERE c.user_id = $1
       ORDER BY ci.created_at DESC`,
      [userId]
    );

    const totalAmount = result.rows.reduce((sum, item) => sum + Number(item.total_price), 0);

    res.json({ success: true, data: { items: result.rows, totalAmount } });
  } catch (error) {
    console.error("getCart error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch cart", code: "SERVER_ERROR" });
  }
};

export const removeFromCart = async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const { cart_item_id } = req.params;

  try {
    const result = await pool.query(
      `DELETE FROM cart_items ci
       USING carts c
       WHERE ci.id = $1 AND ci.cart_id = c.id AND c.user_id = $2
       RETURNING ci.id`,
      [cart_item_id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Cart item not found", code: "NOT_FOUND" });
    }

    res.json({ success: true, message: "Item removed from cart" });
  } catch (error) {
    console.error("removeFromCart error:", error);
    res.status(500).json({ success: false, message: "Failed to remove item", code: "SERVER_ERROR" });
  }
};

export const updateCartQuantity = async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const { cart_item_id } = req.params;
  const { quantity } = req.body;

  if (!Number.isInteger(quantity) || quantity <= 0) {
    return res.status(400).json({ success: false, message: "Quantity must be a positive integer", code: "INVALID_QUANTITY" });
  }

  try {
    const result = await pool.query(
      `UPDATE cart_items ci
       SET quantity = $1, updated_at = NOW()
       FROM carts c
       WHERE ci.id = $2 AND ci.cart_id = c.id AND c.user_id = $3
       RETURNING ci.*`,
      [quantity, cart_item_id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Cart item not found", code: "NOT_FOUND" });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("updateCartQuantity error:", error);
    res.status(500).json({ success: false, message: "Failed to update quantity", code: "SERVER_ERROR" });
  }
};

export const moveWishlistToCart = async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const { product_id } = req.body;

  try {
    const product = await pool.query("SELECT id FROM products WHERE id=$1", [product_id]);
    if (product.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found", code: "NOT_FOUND" });
    }

    const cartId = await getOrCreateCartId(userId);

    await pool.query(
      `INSERT INTO cart_items (cart_id, product_id, quantity)
       VALUES ($1, $2, 1)
       ON CONFLICT (cart_id, product_id)
       DO UPDATE SET quantity = cart_items.quantity + 1, updated_at = NOW()`,
      [cartId, product_id]
    );

    await pool.query(
      `DELETE FROM wishlist_items
       WHERE product_id = $1
       AND wishlist_id = (SELECT id FROM wishlists WHERE user_id = $2)`,
      [product_id, userId]
    );

    res.json({ success: true, message: "Moved to cart successfully" });
  } catch (error) {
    console.error("moveWishlistToCart error:", error);
    res.status(500).json({ success: false, message: "Failed to move item", code: "SERVER_ERROR" });
  }
};

import { Request, Response } from "express";
import { pool } from "../database/db";
import { recordAuditLog } from "../utils/auditLog";

const VALID_TRANSITIONS: Record<string, string[]> = {
  PENDING_PAYMENT: ["PAID", "CANCELLED"],
  PAID: ["PROCESSING", "CANCELLED", "REFUNDED"],
  PROCESSING: ["PACKED", "CANCELLED"],
  PACKED: ["SHIPPED"],
  SHIPPED: ["DELIVERED"],
  DELIVERED: ["REFUNDED"],
  CANCELLED: [],
  REFUNDED: [],
};

// Creates an order from the user's cart. Never trusts client-sent prices/totals —
// everything is recomputed server-side inside a transaction with row locks on
// products.stock to prevent two concurrent checkouts from overselling the same item.
export const createOrder = async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const { shippingAddress } = req.body;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const cartResult = await client.query("SELECT id FROM carts WHERE user_id=$1", [userId]);
    if (cartResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "Cart is empty", code: "EMPTY_CART" });
    }
    const cartId = cartResult.rows[0].id;

    const itemsResult = await client.query(
      "SELECT product_id, quantity FROM cart_items WHERE cart_id=$1 ORDER BY product_id",
      [cartId]
    );
    if (itemsResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "Cart is empty", code: "EMPTY_CART" });
    }

    const productIds = itemsResult.rows.map((r) => r.product_id);
    // FOR UPDATE locks these product rows until commit, serializing concurrent checkouts on the same SKU.
    const productsResult = await client.query(
      "SELECT id, name, price, stock FROM products WHERE id = ANY($1::int[]) FOR UPDATE",
      [productIds]
    );
    const productsById = new Map(productsResult.rows.map((p) => [p.id, p]));

    let totalAmount = 0;
    const orderItems: { product_id: number; product_name: string; quantity: number; price: number }[] = [];

    for (const item of itemsResult.rows) {
      const product = productsById.get(item.product_id);
      if (!product) {
        await client.query("ROLLBACK");
        return res.status(409).json({ success: false, message: `Product ${item.product_id} no longer exists`, code: "PRODUCT_UNAVAILABLE" });
      }
      if (product.stock < item.quantity) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          message: `Insufficient stock for ${product.name}`,
          code: "INSUFFICIENT_STOCK",
        });
      }
      const price = Number(product.price);
      totalAmount += price * item.quantity;
      orderItems.push({ product_id: product.id, product_name: product.name, quantity: item.quantity, price });
    }

    const orderResult = await client.query(
      `INSERT INTO orders (user_id, total_amount, status, shipping_address)
       VALUES ($1, $2, 'PENDING_PAYMENT', $3) RETURNING *`,
      [userId, totalAmount, JSON.stringify(shippingAddress)]
    );
    const order = orderResult.rows[0];

    for (const item of orderItems) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, quantity, price)
         VALUES ($1, $2, $3, $4, $5)`,
        [order.id, item.product_id, item.product_name, item.quantity, item.price]
      );
      await client.query("UPDATE products SET stock = stock - $1 WHERE id = $2", [item.quantity, item.product_id]);
    }

    await client.query("INSERT INTO order_status_history (order_id, status, changed_by) VALUES ($1, 'PENDING_PAYMENT', $2)", [order.id, userId]);

    await client.query("DELETE FROM cart_items WHERE cart_id = $1", [cartId]);

    await client.query("COMMIT");

    res.status(201).json({ success: true, data: { ...order, items: orderItems } });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("createOrder error:", error);
    res.status(500).json({ success: false, message: "Failed to create order", code: "SERVER_ERROR" });
  } finally {
    client.release();
  }
};

export const getMyOrders = async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(50, parseInt(req.query.limit as string) || 10);
  const offset = (page - 1) * limit;

  try {
    const result = await pool.query(
      "SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3",
      [userId, limit, offset]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch orders", code: "SERVER_ERROR" });
  }
};

export const getMyOrderById = async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const { id } = req.params;

  try {
    const order = await pool.query("SELECT * FROM orders WHERE id=$1 AND user_id=$2", [id, userId]);
    if (order.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Order not found", code: "NOT_FOUND" });
    }
    const items = await pool.query("SELECT * FROM order_items WHERE order_id=$1", [id]);
    res.json({ success: true, data: { ...order.rows[0], items: items.rows } });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch order", code: "SERVER_ERROR" });
  }
};

// Admin: list/filter/paginate all orders
export const listOrders = async (req: Request, res: Response) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, parseInt(req.query.limit as string) || 20);
  const offset = (page - 1) * limit;
  const { status } = req.query;

  try {
    const conditions: string[] = [];
    const values: any[] = [];
    if (status) {
      conditions.push(`status = $${values.length + 1}`);
      values.push(status);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await pool.query(
      `SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    );
    const totalResult = await pool.query(`SELECT COUNT(*) FROM orders ${where}`, values);
    const total = parseInt(totalResult.rows[0].count, 10);

    res.json({ success: true, data: result.rows, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch orders", code: "SERVER_ERROR" });
  }
};

// Admin: transition an order's status, enforcing the allowed state machine
export const updateOrderStatus = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { status } = req.body;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT status FROM orders WHERE id=$1 FOR UPDATE", [id]);
    if (existing.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Order not found", code: "NOT_FOUND" });
    }

    const currentStatus = existing.rows[0].status;
    const allowed = VALID_TRANSITIONS[currentStatus] ?? [];
    if (!allowed.includes(status)) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: `Cannot transition order from ${currentStatus} to ${status}`,
        code: "INVALID_TRANSITION",
      });
    }

    // Restock items when an order is cancelled/refunded before shipping.
    if (status === "CANCELLED" || (status === "REFUNDED" && currentStatus !== "DELIVERED")) {
      const items = await client.query("SELECT product_id, quantity FROM order_items WHERE order_id=$1", [id]);
      for (const item of items.rows) {
        await client.query("UPDATE products SET stock = stock + $1 WHERE id = $2", [item.quantity, item.product_id]);
      }
    }

    const result = await client.query(
      "UPDATE orders SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *",
      [status, id]
    );
    await client.query("INSERT INTO order_status_history (order_id, status, changed_by) VALUES ($1, $2, $3)", [id, status, req.user!.sub]);

    await client.query("COMMIT");
    await recordAuditLog(req.user!.sub, "UPDATE_STATUS", "order", id as string, { from: currentStatus, to: status });

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("updateOrderStatus error:", error);
    res.status(500).json({ success: false, message: "Failed to update order status", code: "SERVER_ERROR" });
  } finally {
    client.release();
  }
};

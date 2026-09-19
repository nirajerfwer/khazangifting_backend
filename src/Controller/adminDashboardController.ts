import { Request, Response } from "express";
import { pool } from "../database/db";

// All metrics use SQL aggregation — never load full tables into memory to compute totals.
export const getDashboardSummary = async (_req: Request, res: Response) => {
  try {
    const [orders, revenue, customers, products, lowStock, pendingOrders] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM orders"),
      pool.query("SELECT COALESCE(SUM(total_amount), 0) AS total FROM orders WHERE status NOT IN ('CANCELLED', 'PENDING_PAYMENT')"),
      pool.query("SELECT COUNT(*) FROM users WHERE role = 'CUSTOMER'"),
      pool.query("SELECT COUNT(*) FROM products"),
      pool.query("SELECT COUNT(*) FROM products WHERE stock <= 5"),
      pool.query("SELECT COUNT(*) FROM orders WHERE status = 'PENDING_PAYMENT'"),
    ]);

    const [recentOrders, recentCustomers] = await Promise.all([
      pool.query("SELECT id, user_id, total_amount, status, created_at FROM orders ORDER BY created_at DESC LIMIT 10"),
      pool.query("SELECT id, name, email, created_at FROM users WHERE role = 'CUSTOMER' ORDER BY created_at DESC LIMIT 10"),
    ]);

    res.json({
      success: true,
      data: {
        totalOrders: parseInt(orders.rows[0].count, 10),
        totalRevenue: Number(revenue.rows[0].total),
        totalCustomers: parseInt(customers.rows[0].count, 10),
        totalProducts: parseInt(products.rows[0].count, 10),
        lowStockProducts: parseInt(lowStock.rows[0].count, 10),
        pendingOrders: parseInt(pendingOrders.rows[0].count, 10),
        recentOrders: recentOrders.rows,
        recentCustomers: recentCustomers.rows,
      },
    });
  } catch (error) {
    console.error("getDashboardSummary error:", error);
    res.status(500).json({ success: false, message: "Failed to load dashboard", code: "SERVER_ERROR" });
  }
};

// Admin: list customers with search/pagination
export const listCustomers = async (req: Request, res: Response) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, parseInt(req.query.limit as string) || 20);
  const offset = (page - 1) * limit;
  const search = (req.query.search as string) || "";

  try {
    const values: any[] = [];
    let where = "WHERE role = 'CUSTOMER'";
    if (search) {
      values.push(`%${search}%`);
      where += ` AND (name ILIKE $${values.length} OR email ILIKE $${values.length})`;
    }

    const result = await pool.query(
      `SELECT id, name, email, is_active, created_at FROM users ${where}
       ORDER BY created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    );
    const totalResult = await pool.query(`SELECT COUNT(*) FROM users ${where}`, values);
    const total = parseInt(totalResult.rows[0].count, 10);

    res.json({ success: true, data: result.rows, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } });
  } catch (error) {
    console.error("listCustomers error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch customers", code: "SERVER_ERROR" });
  }
};

// Admin: activate/deactivate a customer account
export const setCustomerActive = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { isActive } = req.body;

  try {
    const result = await pool.query(
      "UPDATE users SET is_active=$1, updated_at=NOW() WHERE id=$2 AND role = 'CUSTOMER' RETURNING id, name, email, is_active",
      [Boolean(isActive), id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Customer not found", code: "NOT_FOUND" });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to update customer", code: "SERVER_ERROR" });
  }
};

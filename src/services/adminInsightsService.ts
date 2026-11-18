import { pool } from "../database/db";
import { HttpError } from "../utils/httpError";
import { recordAuditLog } from "../utils/auditLog";

// "Revenue" = orders that were paid and not refunded/cancelled.
const REVENUE_STATUSES = ["PAID", "PROCESSING", "PACKED", "SHIPPED", "DELIVERED"];
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

// ── Dashboard ─────────────────────────────────────────────────────────────
// Everything is aggregated in SQL; no table is loaded into memory.
export const getDashboard = async (days: number) => {
  const [kpi, series, statuses, best, recent, lowStock, totals] = await Promise.all([
    pool.query(
      `WITH bounds AS (SELECT date_trunc('day', NOW()) - ($1::int - 1) * INTERVAL '1 day' AS cur_start,
                              date_trunc('day', NOW()) - (2 * $1::int - 1) * INTERVAL '1 day' AS prev_start)
       SELECT
         COALESCE(SUM(o.total_amount) FILTER (WHERE o.created_at >= b.cur_start AND o.status = ANY($2::text[])), 0) AS revenue,
         COALESCE(SUM(o.total_amount) FILTER (WHERE o.created_at >= b.prev_start AND o.created_at < b.cur_start AND o.status = ANY($2::text[])), 0) AS prev_revenue,
         COUNT(*) FILTER (WHERE o.created_at >= b.cur_start AND o.status = ANY($2::text[]))::int AS orders,
         COUNT(*) FILTER (WHERE o.created_at >= b.prev_start AND o.created_at < b.cur_start AND o.status = ANY($2::text[]))::int AS prev_orders,
         (SELECT COUNT(*)::int FROM users u, bounds bb WHERE u.role = 'CUSTOMER' AND u.created_at >= bb.cur_start) AS new_customers,
         (SELECT COUNT(*)::int FROM users u, bounds bb WHERE u.role = 'CUSTOMER' AND u.created_at >= bb.prev_start AND u.created_at < bb.cur_start) AS prev_new_customers
       FROM bounds b LEFT JOIN orders o ON o.created_at >= b.prev_start
       GROUP BY b.cur_start, b.prev_start`,
      [days, REVENUE_STATUSES]
    ),
    pool.query(
      `SELECT d::date AS day,
              COALESCE(SUM(o.total_amount) FILTER (WHERE o.status = ANY($2::text[])), 0)::float AS revenue,
              COUNT(o.id) FILTER (WHERE o.status = ANY($2::text[]))::int AS orders
       FROM generate_series(date_trunc('day', NOW()) - ($1::int - 1) * INTERVAL '1 day', date_trunc('day', NOW()), INTERVAL '1 day') d
       LEFT JOIN orders o ON o.created_at >= d AND o.created_at < d + INTERVAL '1 day'
       GROUP BY d ORDER BY d`,
      [days, REVENUE_STATUSES]
    ),
    pool.query("SELECT status, COUNT(*)::int AS count FROM orders GROUP BY status"),
    pool.query(
      `SELECT oi.product_id, MAX(oi.product_name) AS name, SUM(oi.quantity)::int AS units, SUM(oi.quantity * oi.price)::float AS revenue,
              (SELECT image_url FROM product_images pi WHERE pi.product_id = oi.product_id ORDER BY is_primary DESC, sort_order, id LIMIT 1) AS image
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.status = ANY($2::text[]) AND o.created_at >= date_trunc('day', NOW()) - ($1::int - 1) * INTERVAL '1 day'
       GROUP BY oi.product_id ORDER BY units DESC LIMIT 5`,
      [days, REVENUE_STATUSES]
    ),
    pool.query(
      `SELECT o.id, o.status, o.payment_status, o.total_amount, o.created_at, u.name AS customer_name
       FROM orders o LEFT JOIN users u ON u.id = o.user_id ORDER BY o.created_at DESC LIMIT 8`
    ),
    pool.query(
      `SELECT id, name, sku, stock, low_stock_threshold FROM products
       WHERE track_inventory AND stock <= low_stock_threshold ORDER BY stock ASC, id LIMIT 6`
    ),
    // Low stock only counts products whose inventory is tracked (untracked = made to order).
    pool.query(
      `SELECT (SELECT COUNT(*)::int FROM products) AS products,
              (SELECT COUNT(*)::int FROM products WHERE status = 'ACTIVE') AS active_products,
              (SELECT COUNT(*)::int FROM users WHERE role = 'CUSTOMER') AS customers,
              (SELECT COUNT(*)::int FROM orders) AS orders,
              (SELECT COUNT(*)::int FROM orders WHERE status = 'PENDING_PAYMENT') AS pending_payment,
              (SELECT COUNT(*)::int FROM orders WHERE status IN ('PAID','PROCESSING','PACKED')) AS to_fulfil,
              (SELECT COUNT(*)::int FROM products WHERE track_inventory AND stock > 0 AND stock <= low_stock_threshold) AS low_stock,
              (SELECT COUNT(*)::int FROM products WHERE track_inventory AND stock <= 0) AS out_of_stock,
              (SELECT COALESCE(SUM(total_amount), 0)::float FROM orders WHERE status = ANY($1::text[])) AS lifetime_revenue`,
      [REVENUE_STATUSES]
    ),
  ]);
  const k = kpi.rows[0] ?? { revenue: 0, prev_revenue: 0, orders: 0, prev_orders: 0, new_customers: 0, prev_new_customers: 0 };
  const revenue = Number(k.revenue);
  return {
    range: days,
    kpis: {
      revenue,
      prevRevenue: Number(k.prev_revenue),
      orders: k.orders,
      prevOrders: k.prev_orders,
      avgOrderValue: k.orders ? Math.round((revenue / k.orders) * 100) / 100 : 0,
      prevAvgOrderValue: k.prev_orders ? Math.round((Number(k.prev_revenue) / k.prev_orders) * 100) / 100 : 0,
      newCustomers: k.new_customers,
      prevNewCustomers: k.prev_new_customers,
    },
    totals: totals.rows[0],
    series: series.rows.map((r) => ({ day: r.day, revenue: Number(r.revenue), orders: r.orders })),
    statusBreakdown: statuses.rows,
    bestSellers: best.rows,
    recentOrders: recent.rows,
    lowStock: lowStock.rows,
  };
};

// Small, frequently polled payload for the header bell.
export const getAlerts = async () => {
  const r = await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM orders WHERE status IN ('PAID','PROCESSING','PACKED')) AS to_fulfil,
            (SELECT COUNT(*)::int FROM orders WHERE status = 'RETURNED') AS awaiting_refund,
            (SELECT COUNT(*)::int FROM products WHERE track_inventory AND stock > 0 AND stock <= low_stock_threshold) AS low_stock,
            (SELECT COUNT(*)::int FROM products WHERE track_inventory AND stock <= 0) AS out_of_stock`
  );
  return r.rows[0];
};

// ── Global search (header) ────────────────────────────────────────────────
export const globalSearch = async (q: string, canSeeCatalog: boolean) => {
  const term = `%${escapeLike(q.trim().replace(/^#/, "").slice(0, 100))}%`;
  const [products, orders, customers] = await Promise.all([
    canSeeCatalog
      ? pool.query("SELECT id, name, sku, status FROM products WHERE name ILIKE $1 OR sku ILIKE $1 ORDER BY updated_at DESC NULLS LAST LIMIT 5", [term])
      : Promise.resolve({ rows: [] }),
    pool.query(
      `SELECT o.id, o.status, o.total_amount, u.name AS customer_name FROM orders o LEFT JOIN users u ON u.id = o.user_id
       WHERE o.id::text ILIKE $1 OR u.email ILIKE $1 OR u.name ILIKE $1 ORDER BY o.created_at DESC LIMIT 5`,
      [term]
    ),
    pool.query("SELECT id, name, email FROM users WHERE role = 'CUSTOMER' AND (name ILIKE $1 OR email ILIKE $1) ORDER BY created_at DESC LIMIT 5", [term]),
  ]);
  return { products: products.rows, orders: orders.rows, customers: customers.rows };
};

// ── Customers ─────────────────────────────────────────────────────────────
export const listCustomers = async (f: { q?: string; status?: string; sort?: string }, page: number, limit: number) => {
  const conds = ["u.role = 'CUSTOMER'"];
  const values: any[] = [];
  if (f.q?.trim()) {
    values.push(`%${escapeLike(f.q.trim().slice(0, 100))}%`);
    conds.push(`(u.name ILIKE $${values.length} OR u.email ILIKE $${values.length})`);
  }
  if (f.status === "active") conds.push("u.is_active");
  if (f.status === "inactive") conds.push("NOT u.is_active");
  const where = `WHERE ${conds.join(" AND ")}`;
  const order =
    f.sort === "oldest" ? "u.created_at ASC" : f.sort === "spent" ? "spent DESC, u.created_at DESC" : f.sort === "orders" ? "order_count DESC, u.created_at DESC" : "u.created_at DESC";
  values.push(REVENUE_STATUSES);
  const statusParam = values.length;
  const [rows, count] = await Promise.all([
    pool.query(
      `SELECT u.id, u.name, u.email, u.is_active, u.created_at,
              COALESCE(s.order_count, 0)::int AS order_count, COALESCE(s.spent, 0)::float AS spent, s.last_order_at
       FROM users u
       LEFT JOIN (SELECT user_id, COUNT(*) AS order_count,
                         SUM(total_amount) FILTER (WHERE status = ANY($${statusParam}::text[])) AS spent,
                         MAX(created_at) AS last_order_at
                  FROM orders GROUP BY user_id) s ON s.user_id = u.id
       ${where} ORDER BY ${order} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, (page - 1) * limit]
    ),
    pool.query(`SELECT COUNT(*)::int total FROM users u ${where}`, values.slice(0, statusParam - 1)),
  ]);
  const total = count.rows[0].total as number;
  return { data: rows.rows, pagination: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) } };
};

// Profile + stats + addresses. Never selects password or token columns.
export const getCustomer = async (id: string) => {
  const u = await pool.query("SELECT id, name, email, is_active, created_at, updated_at FROM users WHERE id=$1 AND role='CUSTOMER'", [id]);
  if (u.rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Customer not found");
  const [stats, addresses, cart, wishlist] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS orders,
              COALESCE(SUM(total_amount) FILTER (WHERE status = ANY($2::text[])), 0)::float AS spent,
              COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
              MIN(created_at) AS first_order_at, MAX(created_at) AS last_order_at
       FROM orders WHERE user_id = $1`,
      [id, REVENUE_STATUSES]
    ),
    pool.query("SELECT id, full_name, phone, line1, line2, city, state, pincode, is_default FROM addresses WHERE user_id=$1 ORDER BY is_default DESC, created_at DESC", [id]),
    pool.query("SELECT COALESCE(SUM(ci.quantity), 0)::int AS units FROM cart_items ci JOIN carts c ON c.id = ci.cart_id WHERE c.user_id=$1", [id]),
    pool.query("SELECT COUNT(*)::int AS items FROM wishlist_items wi JOIN wishlists w ON w.id = wi.wishlist_id WHERE w.user_id=$1", [id]),
  ]);
  const s = stats.rows[0];
  return {
    ...u.rows[0],
    stats: { ...s, avg_order_value: s.orders ? Math.round((s.spent / s.orders) * 100) / 100 : 0, cart_units: cart.rows[0].units, wishlist_items: wishlist.rows[0].items },
    addresses: addresses.rows,
  };
};

export const setCustomerActive = async (adminId: string, id: string, isActive: boolean) => {
  const r = await pool.query(
    "UPDATE users SET is_active=$1, updated_at=NOW() WHERE id=$2 AND role='CUSTOMER' RETURNING id, name, email, is_active",
    [isActive, id]
  );
  if (r.rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Customer not found");
  await recordAuditLog(adminId, isActive ? "ACTIVATE" : "DEACTIVATE", "customer", id);
  return r.rows[0];
};

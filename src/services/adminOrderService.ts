import { pool, withTransaction } from "../database/db";
import { HttpError } from "../utils/httpError";
import { recordAuditLog } from "../utils/auditLog";
import { restockOrder, getOrderItems } from "./orderService";

// Order lifecycle. Pending = PENDING_PAYMENT, Confirmed = PAID.
export const VALID_TRANSITIONS: Record<string, string[]> = {
  PENDING_PAYMENT: ["PAID", "CANCELLED"],
  PAID: ["PROCESSING", "CANCELLED", "REFUNDED"],
  PROCESSING: ["PACKED", "CANCELLED"],
  PACKED: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["DELIVERED", "RETURNED"],
  DELIVERED: ["RETURNED", "REFUNDED"],
  RETURNED: ["REFUNDED"],
  CANCELLED: [],
  REFUNDED: [],
};

// Tabs in the admin UI map to one or more statuses.
const STATUS_GROUPS: Record<string, string[]> = {
  pending: ["PENDING_PAYMENT"],
  processing: ["PAID", "PROCESSING", "PACKED"],
  shipped: ["SHIPPED"],
  delivered: ["DELIVERED"],
  cancelled: ["CANCELLED"],
  returns: ["RETURNED", "REFUNDED"],
};

const PAID_STATUSES = ["PAID", "PROCESSING", "PACKED", "SHIPPED", "DELIVERED", "RETURNED", "REFUNDED"];
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export interface OrderListFilters {
  group?: string;
  status?: string;
  payment_status?: string;
  q?: string;
  customer_id?: string;
  from?: string;
  to?: string;
  sort?: string;
}

const buildWhere = (f: OrderListFilters, opts: { ignoreGroup?: boolean } = {}) => {
  const conds: string[] = [];
  const values: any[] = [];
  const add = (sql: (n: number) => string, v: any) => {
    values.push(v);
    conds.push(sql(values.length));
  };
  if (!opts.ignoreGroup) {
    if (f.group && STATUS_GROUPS[f.group]) add((n) => `o.status = ANY($${n}::text[])`, STATUS_GROUPS[f.group]);
    else if (f.status && VALID_TRANSITIONS[f.status]) add((n) => `o.status = $${n}`, f.status);
  }
  if (f.payment_status && ["PENDING", "PAID", "FAILED", "REFUNDED"].includes(f.payment_status)) add((n) => `o.payment_status = $${n}`, f.payment_status);
  if (f.customer_id && /^[0-9a-f-]{36}$/i.test(f.customer_id)) add((n) => `o.user_id = $${n}`, f.customer_id);
  if (f.q?.trim()) {
    const q = f.q.trim().replace(/^#/, "").slice(0, 100);
    add(
      (n) => `(o.id::text ILIKE $${n} OR u.email ILIKE $${n} OR u.name ILIKE $${n} OR o.razorpay_order_id ILIKE $${n} OR o.razorpay_payment_id ILIKE $${n} OR o.shipping_address->>'phone' ILIKE $${n})`,
      `%${escapeLike(q)}%`
    );
  }
  if (f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.from)) add((n) => `o.created_at >= $${n}::date`, f.from);
  if (f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to)) add((n) => `o.created_at < ($${n}::date + INTERVAL '1 day')`, f.to);
  return { where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", values };
};

export const listOrders = async (f: OrderListFilters, page: number, limit: number) => {
  const { where, values } = buildWhere(f);
  const order = f.sort === "oldest" ? "o.created_at ASC" : f.sort === "total-desc" ? "o.total_amount DESC, o.created_at DESC" : f.sort === "total-asc" ? "o.total_amount ASC, o.created_at DESC" : "o.created_at DESC";
  const base = buildWhere(f, { ignoreGroup: true });

  const [rows, count, tabs] = await Promise.all([
    pool.query(
      `SELECT o.id, o.status, o.payment_status, o.total_amount, o.created_at, o.updated_at, o.razorpay_payment_id,
              u.id AS customer_id, u.name AS customer_name, u.email AS customer_email,
              o.shipping_address->>'city' AS city,
              COALESCE(items.units, 0)::int AS item_count
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       LEFT JOIN LATERAL (SELECT SUM(quantity) AS units FROM order_items oi WHERE oi.order_id = o.id) items ON TRUE
       ${where} ORDER BY ${order}
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, (page - 1) * limit]
    ),
    pool.query(`SELECT COUNT(*)::int total FROM orders o LEFT JOIN users u ON u.id = o.user_id ${where}`, values),
    // Per-status counts for the tab badges, honouring the other filters (search/date).
    pool.query(`SELECT o.status, COUNT(*)::int n FROM orders o LEFT JOIN users u ON u.id = o.user_id ${base.where} GROUP BY o.status`, base.values),
  ]);
  const byStatus: Record<string, number> = Object.fromEntries(tabs.rows.map((r) => [r.status, r.n]));
  const tabCounts: Record<string, number> = { all: Object.values(byStatus).reduce((a, b) => a + b, 0) };
  for (const [g, statuses] of Object.entries(STATUS_GROUPS)) tabCounts[g] = statuses.reduce((s, st) => s + (byStatus[st] ?? 0), 0);
  const total = count.rows[0].total as number;
  return { data: rows.rows, tabCounts, pagination: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) } };
};

export const getOrder = async (id: string) => {
  const o = await pool.query(
    `SELECT o.*, u.name AS customer_name, u.email AS customer_email, u.created_at AS customer_since
     FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE o.id = $1`,
    [id]
  );
  if (o.rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Order not found");
  const [items, history, customerStats] = await Promise.all([
    getOrderItems(id),
    pool.query(
      `SELECT h.status, h.note, h.created_at, u.name AS changed_by_name, u.role AS changed_by_role
       FROM order_status_history h LEFT JOIN users u ON u.id = h.changed_by
       WHERE h.order_id = $1 ORDER BY h.created_at ASC, h.id ASC`,
      [id]
    ),
    o.rows[0].user_id
      ? pool.query(
          `SELECT COUNT(*)::int orders, COALESCE(SUM(total_amount) FILTER (WHERE status = ANY($2::text[])), 0) AS spent
           FROM orders WHERE user_id = $1`,
          [o.rows[0].user_id, PAID_STATUSES.filter((s) => s !== "REFUNDED")]
        )
      : Promise.resolve({ rows: [{ orders: 0, spent: 0 }] }),
  ]);
  const { idempotency_key, ...order } = o.rows[0];
  return {
    ...order,
    payment_method: order.razorpay_order_id ? "Razorpay" : null,
    items,
    history: history.rows,
    customer_stats: customerStats.rows[0],
    allowed_transitions: VALID_TRANSITIONS[order.status] ?? [],
  };
};

export const updateStatus = async (
  userId: string,
  id: string,
  v: { status: string; note?: string | null; tracking_number?: string | null; courier?: string | null; refund_amount?: number | null; refund_reference?: string | null }
) => {
  const { row, current } = await withTransaction(async (client) => {
    const existing = await client.query("SELECT status, total_amount FROM orders WHERE id=$1 FOR UPDATE", [id]);
    if (existing.rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Order not found");
    const current = existing.rows[0].status as string;
    if (!(VALID_TRANSITIONS[current] ?? []).includes(v.status)) {
      throw new HttpError(409, "INVALID_TRANSITION", `Cannot change order from ${current} to ${v.status}`);
    }
    const total = Number(existing.rows[0].total_amount);
    if (v.status === "REFUNDED" && v.refund_amount != null && v.refund_amount > total) {
      throw new HttpError(422, "INVALID_REFUND", "Refund amount cannot exceed the order total");
    }

    // Stock: cancellation before shipping and physical returns go back on the shelf; a refund of
    // an order that never shipped (PAID → REFUNDED) also restocks. restockOrder is idempotent.
    if (v.status === "CANCELLED") await restockOrder(client, id, "ORDER_CANCELLED", userId);
    if (v.status === "RETURNED") await restockOrder(client, id, "RETURN", userId);
    if (v.status === "REFUNDED" && current === "PAID") await restockOrder(client, id, "ORDER_CANCELLED", userId);

    // Refunds are recorded only — the money is returned in the Razorpay dashboard.
    const r = await client.query(
      // $1 is cast explicitly: it is used both as the column value and in CASE comparisons.
      `UPDATE orders SET status = $1::varchar,
         payment_status = CASE WHEN $1::varchar = 'PAID' THEN 'PAID' WHEN $1::varchar = 'REFUNDED' THEN 'REFUNDED' ELSE payment_status END,
         tracking_number = COALESCE($2, tracking_number),
         courier = COALESCE($3, courier),
         refund_amount = CASE WHEN $1::varchar = 'REFUNDED' THEN COALESCE($4::numeric, total_amount) ELSE refund_amount END,
         refund_reference = CASE WHEN $1::varchar = 'REFUNDED' THEN COALESCE($5, refund_reference) ELSE refund_reference END,
         refunded_at = CASE WHEN $1::varchar = 'REFUNDED' THEN NOW() ELSE refunded_at END,
         updated_at = NOW()
       WHERE id = $6 RETURNING id, status, payment_status`,
      [v.status, v.tracking_number || null, v.courier || null, v.refund_amount ?? null, v.refund_reference || null, id]
    );
    await client.query("INSERT INTO order_status_history (order_id, status, changed_by, note) VALUES ($1, $2, $3, $4)", [id, v.status, userId, v.note || null]);
    return { row: r.rows[0], current };
  });
  // Audit after the transaction has released its connection (see withTransaction).
  await recordAuditLog(userId, "UPDATE_STATUS", "order", id, { from: current, to: v.status });
  return row;
};

export { PAID_STATUSES };

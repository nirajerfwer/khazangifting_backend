import { pool, withTransaction } from "../database/db";
import { HttpError } from "../utils/httpError";
import { recordAuditLog } from "../utils/auditLog";

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export const listInventory = async (f: { q?: string; state?: string; sort?: string }, page: number, limit: number) => {
  const conds: string[] = [];
  const values: any[] = [];
  if (f.q?.trim()) {
    values.push(`%${escapeLike(f.q.trim().slice(0, 100))}%`);
    conds.push(`(p.sku ILIKE $${values.length} OR p.name ILIKE $${values.length})`);
  }
  if (f.state === "out") conds.push("p.track_inventory AND p.stock <= 0");
  else if (f.state === "low") conds.push("p.track_inventory AND p.stock > 0 AND p.stock <= p.low_stock_threshold");
  else if (f.state === "in") conds.push("p.track_inventory AND p.stock > p.low_stock_threshold");
  else if (f.state === "tracked") conds.push("p.track_inventory");
  else if (f.state === "untracked") conds.push("NOT p.track_inventory");
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const order =
    f.sort === "stock-desc" ? "p.stock DESC, p.id" : f.sort === "name" ? "LOWER(p.name), p.id" : f.sort === "updated" ? "p.updated_at DESC NULLS LAST, p.id" : "p.track_inventory DESC, p.stock ASC, p.id";

  const [rows, count, summary] = await Promise.all([
    pool.query(
      `SELECT p.id, p.name, p.sku, p.stock, p.track_inventory, p.low_stock_threshold, p.status, p.updated_at,
              img.image_url AS image,
              CASE WHEN NOT p.track_inventory THEN 'UNTRACKED' WHEN p.stock <= 0 THEN 'OUT' WHEN p.stock <= p.low_stock_threshold THEN 'LOW' ELSE 'IN' END AS stock_state
       FROM products p
       LEFT JOIN LATERAL (SELECT image_url FROM product_images pi WHERE pi.product_id = p.id ORDER BY is_primary DESC, sort_order, id LIMIT 1) img ON TRUE
       ${where} ORDER BY ${order} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, (page - 1) * limit]
    ),
    pool.query(`SELECT COUNT(*)::int total FROM products p ${where}`, values),
    pool.query(`SELECT COUNT(*) FILTER (WHERE track_inventory)::int AS tracked,
                       COUNT(*) FILTER (WHERE track_inventory AND stock <= 0)::int AS out_of_stock,
                       COUNT(*) FILTER (WHERE track_inventory AND stock > 0 AND stock <= low_stock_threshold)::int AS low_stock,
                       COUNT(*) FILTER (WHERE NOT track_inventory)::int AS untracked,
                       COALESCE(SUM(stock) FILTER (WHERE track_inventory), 0)::int AS total_units
                FROM products`),
  ]);
  const total = count.rows[0].total as number;
  return { data: rows.rows, summary: summary.rows[0], pagination: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) } };
};

// Row-locks the product so concurrent adjustments (or a checkout) can't interleave, and writes
// the ledger entry in the same transaction as the stock change.
export const adjustStock = async (
  userId: string,
  v: { product_id: number; mode: "set" | "delta"; quantity: number; reason: string; note?: string | null; track_inventory?: boolean }
) => {
  const { row, before, after } = await withTransaction(async (client) => {
    const cur = await client.query("SELECT stock, track_inventory FROM products WHERE id=$1 FOR UPDATE", [v.product_id]);
    if (cur.rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Product not found");
    const before = cur.rows[0].stock as number;
    const after = v.mode === "set" ? v.quantity : before + v.quantity;
    if (after < 0) throw new HttpError(422, "NEGATIVE_STOCK", `Stock cannot go below zero (current stock is ${before})`);
    if (v.mode === "set" && v.quantity < 0) throw new HttpError(422, "NEGATIVE_STOCK", "Stock cannot be negative");

    const r = await client.query(
      `UPDATE products SET stock=$1, track_inventory=COALESCE($2, track_inventory), updated_at=NOW() WHERE id=$3
       RETURNING id, name, sku, stock, track_inventory, low_stock_threshold`,
      [after, v.track_inventory ?? null, v.product_id]
    );
    if (after !== before) {
      await client.query(
        "INSERT INTO inventory_movements (product_id, change, stock_after, reason, note, created_by) VALUES ($1,$2,$3,$4,$5,$6)",
        [v.product_id, after - before, after, v.reason, v.note ?? null, userId]
      );
    }
    return { row: r.rows[0], before, after };
  });
  // Audit after the transaction has released its connection (see withTransaction).
  await recordAuditLog(userId, "STOCK_ADJUST", "product", v.product_id, { before, after, reason: v.reason });
  return row;
};

// Sets absolute stock for many products atomically (all-or-nothing).
export const bulkSetStock = async (userId: string, items: { product_id: number; stock: number }[], reason: string, note?: string | null) => {
  const byId = new Map<number, number>();
  for (const i of items) byId.set(i.product_id, i.stock);
  const ids = [...byId.keys()].sort((a, b) => a - b); // consistent lock order prevents deadlocks
  const changedCount = await withTransaction(async (client) => {
    const cur = await client.query("SELECT id, stock FROM products WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE", [ids]);
    if (cur.rows.length !== ids.length) throw new HttpError(404, "NOT_FOUND", "One or more products were not found");
    const changed = cur.rows.filter((r) => r.stock !== byId.get(r.id));
    if (changed.length) {
      await client.query(
        `UPDATE products p SET stock = x.stock, updated_at = NOW()
         FROM unnest($1::int[], $2::int[]) AS x(id, stock) WHERE p.id = x.id`,
        [changed.map((r) => r.id), changed.map((r) => byId.get(r.id))]
      );
      await client.query(
        `INSERT INTO inventory_movements (product_id, change, stock_after, reason, note, created_by)
         SELECT x.id, x.change, x.after, $4, $5, $6 FROM unnest($1::int[], $2::int[], $3::int[]) AS x(id, change, after)`,
        [changed.map((r) => r.id), changed.map((r) => byId.get(r.id)! - r.stock), changed.map((r) => byId.get(r.id)), reason, note ?? null, userId]
      );
    }
    return changed.length;
  });
  await recordAuditLog(userId, "BULK_STOCK_SET", "product", undefined, { count: changedCount });
  return { updated: changedCount, unchanged: ids.length - changedCount };
};

export const listMovements = async (f: { product_id?: number; reason?: string }, page: number, limit: number) => {
  const conds: string[] = [];
  const values: any[] = [];
  if (f.product_id) {
    values.push(f.product_id);
    conds.push(`m.product_id = $${values.length}`);
  }
  if (f.reason) {
    values.push(f.reason);
    conds.push(`m.reason = $${values.length}`);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const [rows, count] = await Promise.all([
    pool.query(
      `SELECT m.id, m.product_id, p.name AS product_name, p.sku, m.change, m.stock_after, m.reason, m.reference, m.note,
              m.created_at, u.name AS created_by_name
       FROM inventory_movements m
       JOIN products p ON p.id = m.product_id
       LEFT JOIN users u ON u.id = m.created_by
       ${where} ORDER BY m.created_at DESC, m.id DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, (page - 1) * limit]
    ),
    pool.query(`SELECT COUNT(*)::int total FROM inventory_movements m ${where}`, values),
  ]);
  const total = count.rows[0].total as number;
  return { data: rows.rows, pagination: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) } };
};

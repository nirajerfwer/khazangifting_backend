import { PoolClient } from "pg";
import { pool, withTransaction } from "../database/db";
import { HttpError, isUniqueViolation } from "../utils/httpError";
import { razorpay } from "../utils/razorpay";
import { recordAuditLog } from "../utils/auditLog";
import { computeShipping, priceLines, roundMoney } from "./catalogService";
import { getCart } from "./cartService";

export interface AddressInput {
  fullName: string;
  phone: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  pincode: string;
}

export interface CreateOrderInput {
  shippingAddress?: AddressInput;
  addressId?: number;
  billingAddress?: AddressInput;
  billingAddressId?: number;
  idempotencyKey?: string;
}

const ORDER_COLUMNS = `id, user_id, status, payment_status, subtotal, shipping_amount, discount_amount, total_amount,
  shipping_address, billing_address, razorpay_order_id, created_at, updated_at`;

const addressFromRow = (r: any): AddressInput => ({
  fullName: r.full_name,
  phone: r.phone,
  line1: r.line1,
  line2: r.line2 ?? undefined,
  city: r.city,
  state: r.state,
  pincode: r.pincode,
});

// Saved addresses are looked up with the user id in the WHERE clause, so a user can never
// ship to (or read) another user's address by guessing its id.
const loadOwnAddress = async (db: Pick<PoolClient, "query">, userId: string, addressId: number) => {
  const r = await db.query("SELECT * FROM addresses WHERE id=$1 AND user_id=$2", [addressId, userId]);
  if (r.rows.length === 0) throw new HttpError(404, "ADDRESS_NOT_FOUND", "Address not found");
  return addressFromRow(r.rows[0]);
};

export const getCheckoutSummary = async (userId: string) => {
  const cart = await getCart(userId);
  return {
    ...cart,
    discount: 0, // no coupon system exists yet; kept explicit so the UI and order record agree
    canCheckout: cart.items.length > 0 && !cart.hasIssues,
  };
};

// Restocks only the lines whose inventory was actually decremented at order time, and at most
// once per order (stock_restored flag), e.g. RETURNED followed by REFUNDED won't restock twice.
// Each restock is written to the inventory ledger.
export const restockOrder = async (
  client: PoolClient,
  orderId: string,
  reason: "ORDER_CANCELLED" | "RETURN" = "ORDER_CANCELLED",
  userId: string | null = null
) => {
  const flag = await client.query("UPDATE orders SET stock_restored = TRUE WHERE id=$1 AND stock_restored = FALSE RETURNING id", [orderId]);
  if (flag.rows.length === 0) return;
  const restocked = await client.query(
    `UPDATE products p SET stock = p.stock + oi.quantity
     FROM order_items oi
     WHERE oi.order_id = $1 AND oi.product_id = p.id AND oi.inventory_tracked = TRUE
     RETURNING p.id, oi.quantity, p.stock`,
    [orderId]
  );
  if (restocked.rows.length) {
    await client.query(
      `INSERT INTO inventory_movements (product_id, change, stock_after, reason, reference, created_by)
       SELECT x.id, x.qty, x.after, $4, $5, $6 FROM unnest($1::int[], $2::int[], $3::int[]) AS x(id, qty, after)`,
      [restocked.rows.map((r) => r.id), restocked.rows.map((r) => r.quantity), restocked.rows.map((r) => r.stock), reason, orderId, userId]
    );
  }
};

// Sentinel used inside createOrder's transaction to signal a lost idempotency-key race.
const DUPLICATE_SUBMIT = new Error("DUPLICATE_SUBMIT");

const findByIdempotencyKey = async (userId: string, key: string) => {
  const r = await pool.query(`SELECT ${ORDER_COLUMNS} FROM orders WHERE user_id=$1 AND idempotency_key=$2`, [userId, key]);
  return r.rows[0] ?? null;
};

// Creates the order from the user's server-side cart. Prices, totals and the user id all come
// from the database / verified token — never from the request body. Product rows are locked
// (FOR UPDATE) so concurrent checkouts can't oversell a tracked product.
export const createOrder = async (userId: string, input: CreateOrderInput) => {
  if (input.idempotencyKey) {
    const existing = await findByIdempotencyKey(userId, input.idempotencyKey);
    if (existing) return { order: existing, items: await getOrderItems(existing.id), duplicate: true };
  }

  const client = await pool.connect();
  let duplicateSubmit = false;
  let pendingError: unknown = null;
  let order: any;
  let items: any[] = [];
  try {
    await client.query("BEGIN");

    const shippingAddress = input.addressId ? await loadOwnAddress(client, userId, input.addressId) : input.shippingAddress;
    if (!shippingAddress) throw new HttpError(422, "ADDRESS_REQUIRED", "A shipping address is required");
    const billingAddress = input.billingAddressId
      ? await loadOwnAddress(client, userId, input.billingAddressId)
      : input.billingAddress ?? shippingAddress;

    // Lock the cart row first: two simultaneous checkouts by the same user serialize here, so
    // the second one sees an empty cart instead of creating a duplicate order.
    const cartRow = await client.query("SELECT id FROM carts WHERE user_id=$1 FOR UPDATE", [userId]);
    if (cartRow.rows.length === 0) throw new HttpError(400, "EMPTY_CART", "Cart is empty");
    const cartId = cartRow.rows[0].id;

    const cartItems = await client.query("SELECT product_id, quantity FROM cart_items WHERE cart_id=$1 ORDER BY product_id", [cartId]);
    if (cartItems.rows.length === 0) throw new HttpError(400, "EMPTY_CART", "Cart is empty");

    const lines = await priceLines(client, cartItems.rows, { lock: true });
    const problems = lines.filter((l) => !l.is_available);
    if (problems.length > 0) {
      throw new HttpError(409, "CART_INVALID", "Some items in your cart are unavailable or exceed available stock. Please review your cart.", {
        items: problems.map((p) => ({ product_id: p.product_id, name: p.name, issue: p.issue, available: p.stock_available })),
      });
    }

    const subtotal = roundMoney(lines.reduce((s, l) => s + l.line_total, 0));
    const shipping = computeShipping(subtotal);
    const discount = 0;
    const total = roundMoney(subtotal + shipping - discount);

    const tracked = await client.query("SELECT id FROM products WHERE id = ANY($1::int[]) AND track_inventory = TRUE", [lines.map((l) => l.product_id)]);
    const trackedIds = new Set<number>(tracked.rows.map((r) => r.id));

    try {
      const orderResult = await client.query(
        `INSERT INTO orders (user_id, total_amount, subtotal, shipping_amount, discount_amount, status, payment_status,
                             shipping_address, billing_address, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, 'PENDING_PAYMENT', 'PENDING', $6, $7, $8)
         RETURNING ${ORDER_COLUMNS}`,
        [userId, total, subtotal, shipping, discount, JSON.stringify(shippingAddress), JSON.stringify(billingAddress), input.idempotencyKey ?? null]
      );
      order = orderResult.rows[0];
    } catch (err) {
      // A concurrent submit with the same idempotency key won the race. Signal it and look the
      // winning order up only after this connection is released (pool calls while holding a
      // client can starve the pool).
      if (isUniqueViolation(err) && input.idempotencyKey) throw DUPLICATE_SUBMIT;
      throw err;
    }

    // Snapshot rows: name/SKU/price are copied so later product edits never rewrite history.
    const itemsResult = await client.query(
      `INSERT INTO order_items (order_id, product_id, product_name, sku, quantity, price, inventory_tracked)
       SELECT $1, x.product_id, x.name, x.sku, x.quantity, x.price, x.tracked
       FROM unnest($2::int[], $3::text[], $4::text[], $5::int[], $6::numeric[], $7::bool[])
            AS x(product_id, name, sku, quantity, price, tracked)
       RETURNING id, product_id, product_name, sku, quantity, price`,
      [
        order.id,
        lines.map((l) => l.product_id),
        lines.map((l) => l.name),
        lines.map((l) => l.sku),
        lines.map((l) => l.quantity),
        lines.map((l) => l.unit_price),
        lines.map((l) => trackedIds.has(l.product_id)),
      ]
    );
    items = itemsResult.rows;

    // Decrement only tracked products. The stock >= quantity guard plus the row locks above
    // mean this can't go negative; the CHECK (stock >= 0) constraint is a final backstop.
    const trackedLines = lines.filter((l) => trackedIds.has(l.product_id));
    if (trackedLines.length > 0) {
      const dec = await client.query(
        `UPDATE products p SET stock = p.stock - x.quantity
         FROM unnest($1::int[], $2::int[]) AS x(product_id, quantity)
         WHERE p.id = x.product_id AND p.stock >= x.quantity
         RETURNING p.id, x.quantity, p.stock`,
        [trackedLines.map((l) => l.product_id), trackedLines.map((l) => l.quantity)]
      );
      if (dec.rows.length !== trackedLines.length) {
        throw new HttpError(409, "INSUFFICIENT_STOCK", "Stock changed while placing your order. Please review your cart.");
      }
      await client.query(
        `INSERT INTO inventory_movements (product_id, change, stock_after, reason, reference, created_by)
         SELECT x.id, -x.qty, x.after, 'ORDER', $4, $5 FROM unnest($1::int[], $2::int[], $3::int[]) AS x(id, qty, after)`,
        [dec.rows.map((r) => r.id), dec.rows.map((r) => r.quantity), dec.rows.map((r) => r.stock), order.id, userId]
      );
    }

    await client.query("INSERT INTO order_status_history (order_id, status, changed_by) VALUES ($1, 'PENDING_PAYMENT', $2)", [order.id, userId]);
    await client.query("DELETE FROM cart_items WHERE cart_id = $1", [cartId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    // A duplicate submit that waited on the cart lock finds the cart already emptied by the
    // winning request; with an idempotency key, check below whether that order exists.
    const lostRace = err === DUPLICATE_SUBMIT || (!!input.idempotencyKey && err instanceof HttpError && err.code === "EMPTY_CART");
    if (!lostRace) throw err;
    duplicateSubmit = true;
    pendingError = err;
  } finally {
    client.release();
  }

  if (duplicateSubmit) {
    const existing = await findByIdempotencyKey(userId, input.idempotencyKey!);
    if (existing) return { order: existing, items: await getOrderItems(existing.id), duplicate: true };
    if (pendingError instanceof HttpError) throw pendingError;
    throw new HttpError(409, "DUPLICATE_SUBMIT", "This order is already being placed. Please check your orders.");
  }

  await recordAuditLog(userId, "CREATE", "order", order.id, { total: order.total_amount });
  return { order, items, duplicate: false };
};

export const getOrderItems = async (orderId: string) => {
  const r = await pool.query(
    `SELECT oi.id, oi.product_id, oi.product_name, oi.sku, oi.quantity, oi.price,
            ROUND(oi.price * oi.quantity, 2) AS line_total, img.image_url AS image
     FROM order_items oi
     LEFT JOIN LATERAL (
       SELECT pi.image_url FROM product_images pi WHERE pi.product_id = oi.product_id
       ORDER BY pi.is_primary DESC, pi.sort_order ASC, pi.id ASC LIMIT 1
     ) img ON TRUE
     WHERE oi.order_id = $1 ORDER BY oi.id`,
    [orderId]
  );
  return r.rows;
};

// Creates (or reuses) the Razorpay order for one of the user's unpaid orders. Done outside the
// order transaction so a gateway outage never rolls back or blocks order creation; the user
// can retry payment later from the order page.
export const preparePayment = async (userId: string, orderId: string) => {
  const r = await pool.query(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id=$1 AND user_id=$2`, [orderId, userId]);
  const order = r.rows[0];
  if (!order) throw new HttpError(404, "NOT_FOUND", "Order not found");
  if (order.status !== "PENDING_PAYMENT") throw new HttpError(409, "NOT_PAYABLE", "This order is not awaiting payment");

  let razorpayOrderId: string = order.razorpay_order_id;
  if (!razorpayOrderId) {
    try {
      const rp = await razorpay.orders.create({
        amount: Math.round(Number(order.total_amount) * 100), // paise
        currency: "INR",
        receipt: order.id,
        notes: { orderId: order.id, userId },
      });
      razorpayOrderId = rp.id;
    } catch (err) {
      console.error("Razorpay order creation failed:", (err as any)?.error ?? (err as Error)?.message ?? err);
      throw new HttpError(502, "PAYMENT_INIT_FAILED", "Could not start payment. Your order is saved — please retry from your orders page.", {
        orderId: order.id,
      });
    }
    // Conditional update so a concurrent retry can't overwrite an id already attached.
    const upd = await pool.query(
      "UPDATE orders SET razorpay_order_id=$1, updated_at=NOW() WHERE id=$2 AND razorpay_order_id IS NULL RETURNING razorpay_order_id",
      [razorpayOrderId, order.id]
    );
    if (upd.rows.length === 0) {
      const again = await pool.query("SELECT razorpay_order_id FROM orders WHERE id=$1", [order.id]);
      razorpayOrderId = again.rows[0].razorpay_order_id;
    }
  }

  return {
    orderId: order.id,
    razorpayOrderId,
    razorpayKeyId: process.env.RAZORPAY_KEY_ID, // publishable key id; the secret never leaves the server
    amount: Math.round(Number(order.total_amount) * 100),
    currency: "INR",
  };
};

// Customers may cancel their own order only while it is still unpaid; stock is returned.
export const cancelOwnOrder = async (userId: string, orderId: string) => {
  const cancelled = await withTransaction(async (client) => {
    const r = await client.query("SELECT status FROM orders WHERE id=$1 AND user_id=$2 FOR UPDATE", [orderId, userId]);
    if (r.rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Order not found");
    if (r.rows[0].status !== "PENDING_PAYMENT") {
      throw new HttpError(409, "NOT_CANCELLABLE", "Only unpaid orders can be cancelled online. Please contact support.");
    }
    await restockOrder(client, orderId, "ORDER_CANCELLED", userId);
    const upd = await client.query(
      `UPDATE orders SET status='CANCELLED', updated_at=NOW() WHERE id=$1 RETURNING ${ORDER_COLUMNS}`,
      [orderId]
    );
    await client.query("INSERT INTO order_status_history (order_id, status, changed_by) VALUES ($1, 'CANCELLED', $2)", [orderId, userId]);
    return upd.rows[0];
  });
  // Audit after the transaction has released its connection (see withTransaction).
  await recordAuditLog(userId, "CANCEL", "order", orderId);
  return cancelled;
};

export const listMyOrders = async (userId: string, page: number, limit: number) => {
  const offset = (page - 1) * limit;
  // Item count and first item name come from one aggregate join (no per-order queries).
  const [rows, count] = await Promise.all([
    pool.query(
      `SELECT o.id, o.status, o.payment_status, o.total_amount, o.created_at,
              COALESCE(SUM(oi.quantity), 0)::int AS item_count,
              (ARRAY_AGG(oi.product_name ORDER BY oi.id))[1] AS first_item_name,
              COUNT(oi.id)::int AS line_count
       FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.user_id = $1
       GROUP BY o.id
       ORDER BY o.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    ),
    pool.query("SELECT COUNT(*)::int AS total FROM orders WHERE user_id=$1", [userId]),
  ]);
  const total = count.rows[0].total as number;
  return { data: rows.rows, pagination: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) } };
};

export const getMyOrder = async (userId: string, orderId: string) => {
  const r = await pool.query(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id=$1 AND user_id=$2`, [orderId, userId]);
  if (r.rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Order not found");
  const [items, history] = await Promise.all([
    getOrderItems(orderId),
    pool.query("SELECT status, created_at FROM order_status_history WHERE order_id=$1 ORDER BY created_at ASC, id ASC", [orderId]),
  ]);
  return { ...r.rows[0], items, history: history.rows };
};

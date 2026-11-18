import { PoolClient } from "pg";
import { pool } from "../database/db";
import { HttpError } from "../utils/httpError";
import { computeShipping, fetchProducts, lineIssue, MAX_LINE_QUANTITY, maxQuantityFor, priceLines, PricedLine, sumLines } from "./catalogService";

type Queryable = Pick<PoolClient, "query">;

export interface CartLine extends PricedLine {
  id: number; // cart_items.id (absent for guest previews -> 0)
}

export interface CartSummary {
  items: CartLine[];
  itemCount: number; // total units across available + unavailable lines (what the header badge shows)
  lineCount: number;
  subtotal: number;
  shipping: number;
  total: number;
  hasIssues: boolean;
  /** @deprecated kept for backward compatibility with the previous GET /api/cart shape */
  totalAmount: number;
}

// Atomic get-or-create: relies on the UNIQUE(user_id) index added in setupDatabase, so two
// concurrent first requests for the same user can never create two carts.
export const getOrCreateCartId = async (db: Queryable, userId: string): Promise<string> => {
  const result = await db.query(
    `INSERT INTO carts (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
     RETURNING id`,
    [userId]
  );
  return result.rows[0].id;
};

export const buildSummary = (items: CartLine[]): CartSummary => {
  const subtotal = sumLines(items);
  const shipping = computeShipping(subtotal);
  return {
    items,
    itemCount: items.reduce((s, i) => s + i.quantity, 0),
    lineCount: items.length,
    subtotal,
    shipping,
    total: Math.round((subtotal + shipping) * 100) / 100,
    hasIssues: items.some((i) => !i.is_available),
    totalAmount: subtotal,
  };
};

export const getCart = async (userId: string, db: Queryable = pool): Promise<CartSummary> => {
  const rows = await db.query(
    `SELECT ci.id, ci.product_id, ci.quantity
     FROM cart_items ci JOIN carts c ON c.id = ci.cart_id
     WHERE c.user_id = $1
     ORDER BY ci.created_at DESC, ci.id DESC`,
    [userId]
  );
  const priced = await priceLines(db, rows.rows);
  return buildSummary(priced.map((line, i) => ({ ...line, id: rows.rows[i].id })));
};

// Validates a product for a desired final quantity and returns the product row.
const assertPurchasable = async (db: Queryable, productId: number, quantity: number) => {
  const product = (await fetchProducts(db, [productId])).get(productId);
  const issue = lineIssue(product, quantity);
  if (!product || issue === "UNAVAILABLE") {
    throw new HttpError(404, "PRODUCT_UNAVAILABLE", "This product is no longer available");
  }
  if (issue === "OUT_OF_STOCK") {
    throw new HttpError(409, "OUT_OF_STOCK", `${product.name} is out of stock`);
  }
  if (issue === "INSUFFICIENT_STOCK") {
    throw new HttpError(409, "INSUFFICIENT_STOCK", `Only ${product.stock} unit(s) of ${product.name} available`, {
      available: product.stock,
    });
  }
  if (issue === "BELOW_MOQ") {
    throw new HttpError(422, "BELOW_MOQ", `Minimum order quantity for ${product.name} is ${product.min_quantity}`, {
      minQuantity: product.min_quantity,
    });
  }
  if (quantity > MAX_LINE_QUANTITY) {
    throw new HttpError(422, "QUANTITY_TOO_LARGE", `Maximum quantity per item is ${MAX_LINE_QUANTITY}`);
  }
  return product;
};

export const addItem = async (userId: string, productId: number, quantity: number) => {
  const product = (await fetchProducts(pool, [productId])).get(productId);
  if (!product || !product.is_active) {
    throw new HttpError(404, "PRODUCT_UNAVAILABLE", "This product is no longer available");
  }

  const cartId = await getOrCreateCartId(pool, userId);
  const existing = await pool.query("SELECT quantity FROM cart_items WHERE cart_id=$1 AND product_id=$2", [cartId, productId]);
  const current = existing.rows[0]?.quantity ?? 0;
  // A first add below the MOQ is raised to the MOQ instead of rejected: friendlier, and the
  // price shown in the cart reflects exactly what will be charged.
  const desired = Math.max(current + quantity, product.min_quantity);
  await assertPurchasable(pool, productId, desired);

  // The WHERE on the conflict branch makes the stock ceiling atomic against concurrent adds:
  // if another request raced us past the limit, no row is returned and we reject.
  const limit = maxQuantityFor(product);
  const result = await pool.query(
    `INSERT INTO cart_items (cart_id, product_id, quantity)
     VALUES ($1, $2, $3)
     ON CONFLICT (cart_id, product_id)
     DO UPDATE SET quantity = GREATEST(cart_items.quantity + $4, $5), updated_at = NOW()
     WHERE GREATEST(cart_items.quantity + $4, $5) <= $6
     RETURNING id`,
    [cartId, productId, desired, quantity, product.min_quantity, limit]
  );
  if (result.rows.length === 0) {
    throw new HttpError(409, "INSUFFICIENT_STOCK", `Only ${product.stock} unit(s) of ${product.name} available`, {
      available: product.stock,
    });
  }
  return getCart(userId);
};

export const updateItemQuantity = async (userId: string, cartItemId: number, quantity: number) => {
  // Ownership check is part of the lookup: another user's cart_item_id simply isn't found.
  const owned = await pool.query(
    `SELECT ci.product_id FROM cart_items ci JOIN carts c ON c.id = ci.cart_id
     WHERE ci.id = $1 AND c.user_id = $2`,
    [cartItemId, userId]
  );
  if (owned.rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Cart item not found");

  await assertPurchasable(pool, owned.rows[0].product_id, quantity);

  await pool.query(
    `UPDATE cart_items ci SET quantity = $1, updated_at = NOW()
     FROM carts c WHERE ci.id = $2 AND ci.cart_id = c.id AND c.user_id = $3`,
    [quantity, cartItemId, userId]
  );
  return getCart(userId);
};

export const removeItem = async (userId: string, cartItemId: number) => {
  const result = await pool.query(
    `DELETE FROM cart_items ci USING carts c
     WHERE ci.id = $1 AND ci.cart_id = c.id AND c.user_id = $2
     RETURNING ci.id`,
    [cartItemId, userId]
  );
  if (result.rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Cart item not found");
  return getCart(userId);
};

export const clearCart = async (userId: string) => {
  await pool.query(`DELETE FROM cart_items ci USING carts c WHERE ci.cart_id = c.id AND c.user_id = $1`, [userId]);
  return getCart(userId);
};

// Merges a guest (localStorage) cart into the account cart after login. Quantities are
// combined with GREATEST, not summed, so re-sending the same guest cart (e.g. a retry or a
// second tab) can't double the quantities. Each line is clamped to stock / MOQ and lines
// for unavailable products are skipped and reported back.
export const mergeGuestCart = async (userId: string, items: { product_id: number; quantity: number }[]) => {
  const merged = new Map<number, number>();
  for (const i of items) merged.set(i.product_id, Math.max(merged.get(i.product_id) ?? 0, i.quantity));

  const skipped: { product_id: number; reason: string }[] = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cartId = await getOrCreateCartId(client, userId);
    const products = await fetchProducts(client, [...merged.keys()]);
    const existing = await client.query("SELECT product_id, quantity FROM cart_items WHERE cart_id=$1", [cartId]);
    const existingQty = new Map<number, number>(existing.rows.map((r) => [r.product_id, r.quantity]));

    const toUpsert: { product_id: number; quantity: number }[] = [];
    for (const [productId, guestQty] of merged) {
      const p = products.get(productId);
      if (!p || !p.is_active) {
        skipped.push({ product_id: productId, reason: "UNAVAILABLE" });
        continue;
      }
      const limit = maxQuantityFor(p);
      const target = Math.min(Math.max(guestQty, existingQty.get(productId) ?? 0, p.min_quantity), limit);
      if (target <= 0 || target < p.min_quantity) {
        skipped.push({ product_id: productId, reason: "OUT_OF_STOCK" });
        continue;
      }
      if (target < guestQty) skipped.push({ product_id: productId, reason: "QUANTITY_REDUCED" });
      toUpsert.push({ product_id: productId, quantity: target });
    }

    if (toUpsert.length > 0) {
      // Single statement for all lines instead of one INSERT per item.
      await client.query(
        `INSERT INTO cart_items (cart_id, product_id, quantity)
         SELECT $1, x.product_id, x.quantity
         FROM unnest($2::int[], $3::int[]) AS x(product_id, quantity)
         ON CONFLICT (cart_id, product_id)
         DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = NOW()`,
        [cartId, toUpsert.map((u) => u.product_id), toUpsert.map((u) => u.quantity)]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return { cart: await getCart(userId), skipped };
};

// Server-priced summary for a guest cart held in the browser, so guests see real prices and
// availability without the server ever trusting a client-supplied price.
export const previewGuestCart = async (items: { product_id: number; quantity: number }[]) => {
  const merged = new Map<number, number>();
  for (const i of items) merged.set(i.product_id, (merged.get(i.product_id) ?? 0) + i.quantity);
  const lines = [...merged].map(([product_id, quantity]) => ({ product_id, quantity: Math.min(quantity, MAX_LINE_QUANTITY) }));
  const priced = await priceLines(pool, lines);
  return buildSummary(priced.map((l) => ({ ...l, id: 0 })));
};

export const moveFromWishlist = async (userId: string, productId: number, removeFromWishlist: boolean) => {
  const cart = await addItem(userId, productId, 1);
  if (removeFromWishlist) {
    await pool.query(
      `DELETE FROM wishlist_items wi USING wishlists w
       WHERE wi.wishlist_id = w.id AND w.user_id = $1 AND wi.product_id = $2`,
      [userId, productId]
    );
  }
  return cart;
};

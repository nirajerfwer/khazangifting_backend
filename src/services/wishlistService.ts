import { PoolClient } from "pg";
import { pool } from "../database/db";
import { HttpError } from "../utils/httpError";
import { fetchProducts, lineIssue, PRODUCT_FIELDS_SQL, PRODUCT_JOINS_SQL } from "./catalogService";

type Queryable = Pick<PoolClient, "query">;

// Atomic get-or-create backed by the UNIQUE(user_id) index on wishlists.
const getOrCreateWishlistId = async (db: Queryable, userId: string): Promise<string> => {
  const result = await db.query(
    `INSERT INTO wishlists (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
     RETURNING id`,
    [userId]
  );
  return result.rows[0].id;
};

export const addProduct = async (userId: string, productId: number) => {
  const product = (await fetchProducts(pool, [productId])).get(productId);
  if (!product || !product.is_active) {
    throw new HttpError(404, "PRODUCT_UNAVAILABLE", "This product is no longer available");
  }
  const wishlistId = await getOrCreateWishlistId(pool, userId);
  // UNIQUE(wishlist_id, product_id) + DO NOTHING makes this idempotent: no duplicates.
  const result = await pool.query(
    `INSERT INTO wishlist_items (wishlist_id, product_id) VALUES ($1, $2)
     ON CONFLICT (wishlist_id, product_id) DO NOTHING
     RETURNING id`,
    [wishlistId, productId]
  );
  return { product_id: productId, added: result.rows.length > 0 };
};

export const listItems = async (userId: string, page: number, limit: number) => {
  const offset = (page - 1) * limit;
  const [rows, count] = await Promise.all([
    pool.query(
      `SELECT wi.id AS wishlist_item_id, wi.created_at AS added_at, p.description, ${PRODUCT_FIELDS_SQL}
       FROM wishlists w
       JOIN wishlist_items wi ON wi.wishlist_id = w.id
       JOIN products p ON p.id = wi.product_id
       ${PRODUCT_JOINS_SQL}
       WHERE w.user_id = $1
       ORDER BY wi.created_at DESC, wi.id DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM wishlist_items wi JOIN wishlists w ON w.id = wi.wishlist_id WHERE w.user_id = $1`,
      [userId]
    ),
  ]);

  const items = rows.rows.map((r) => {
    const issue = lineIssue(r, Math.max(1, r.min_quantity));
    const price = Number(r.price);
    const compareAt = r.compare_at_price != null ? Number(r.compare_at_price) : null;
    return {
      wishlist_item_id: r.wishlist_item_id,
      product_id: r.id,
      name: r.name,
      sku: r.sku,
      description: r.description,
      image: r.image,
      price,
      compare_at_price: compareAt,
      discount_percent: compareAt && compareAt > price ? Math.round(((compareAt - price) / compareAt) * 100) : null,
      min_quantity: r.min_quantity,
      stock_available: r.track_inventory ? Math.max(0, r.stock) : null,
      is_available: issue === null,
      issue,
      added_at: r.added_at,
    };
  });

  const total = count.rows[0].total as number;
  return { count: total, items, pagination: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) } };
};

// Lightweight id list so the UI can render filled/unfilled hearts on any page with one request.
export const listProductIds = async (userId: string): Promise<number[]> => {
  const result = await pool.query(
    `SELECT wi.product_id FROM wishlist_items wi JOIN wishlists w ON w.id = wi.wishlist_id WHERE w.user_id = $1`,
    [userId]
  );
  return result.rows.map((r) => r.product_id);
};

export const isInWishlist = async (userId: string, productId: number) => {
  const result = await pool.query(
    `SELECT 1 FROM wishlist_items wi JOIN wishlists w ON w.id = wi.wishlist_id
     WHERE w.user_id = $1 AND wi.product_id = $2`,
    [userId, productId]
  );
  return result.rows.length > 0;
};

export const removeByItemId = async (userId: string, wishlistItemId: number) => {
  const result = await pool.query(
    `DELETE FROM wishlist_items wi USING wishlists w
     WHERE wi.id = $1 AND wi.wishlist_id = w.id AND w.user_id = $2
     RETURNING wi.id, wi.product_id`,
    [wishlistItemId, userId]
  );
  if (result.rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Item not found");
  return result.rows[0];
};

export const removeByProductId = async (userId: string, productId: number) => {
  const result = await pool.query(
    `DELETE FROM wishlist_items wi USING wishlists w
     WHERE wi.product_id = $1 AND wi.wishlist_id = w.id AND w.user_id = $2
     RETURNING wi.id, wi.product_id`,
    [productId, userId]
  );
  if (result.rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Item not found");
  return result.rows[0];
};

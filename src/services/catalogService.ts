import { PoolClient } from "pg";

type Queryable = Pick<PoolClient, "query">;

// Hard ceiling per cart line. Corporate orders can be large, but an unbounded integer
// would let a client overflow totals or tie up stock with absurd quantities.
export const MAX_LINE_QUANTITY = 10000;

export type LineIssue = "UNAVAILABLE" | "OUT_OF_STOCK" | "INSUFFICIENT_STOCK" | "BELOW_MOQ";

export interface PricedLine {
  product_id: number;
  name: string;
  sku: string | null;
  image: string | null;
  quantity: number;
  base_price: number;
  unit_price: number;
  compare_at_price: number | null;
  line_total: number;
  min_quantity: number;
  // null means inventory is not tracked for this product (made-to-order): no stock ceiling.
  stock_available: number | null;
  is_available: boolean;
  issue: LineIssue | null;
}

export interface ProductRow {
  id: number;
  name: string;
  sku: string | null;
  price: string;
  compare_at_price: string | null;
  stock: number;
  track_inventory: boolean;
  is_active: boolean;
  min_quantity: number;
  image: string | null;
}

// One query for every product field the cart/wishlist/checkout need, including the primary
// image and MOQ, so callers never loop per product (no N+1).
export const PRODUCT_FIELDS_SQL = `
  p.id, p.name, p.sku, p.price, p.compare_at_price, p.stock, p.track_inventory, p.is_active,
  COALESCE(m.min_quantity, 1) AS min_quantity,
  img.image_url AS image`;

export const PRODUCT_JOINS_SQL = `
  LEFT JOIN product_moq m ON m.product_id = p.id
  LEFT JOIN LATERAL (
    SELECT pi.image_url FROM product_images pi
    WHERE pi.product_id = p.id
    ORDER BY pi.is_primary DESC, pi.sort_order ASC, pi.id ASC
    LIMIT 1
  ) img ON TRUE`;

export const fetchProducts = async (db: Queryable, productIds: number[], lock = false): Promise<Map<number, ProductRow>> => {
  if (productIds.length === 0) return new Map();
  // FOR UPDATE OF p locks only the product rows (not the joined tables) for checkout.
  const result = await db.query<ProductRow>(
    `SELECT ${PRODUCT_FIELDS_SQL}
     FROM products p ${PRODUCT_JOINS_SQL}
     WHERE p.id = ANY($1::int[])
     ORDER BY p.id
     ${lock ? "FOR UPDATE OF p" : ""}`,
    [productIds]
  );
  return new Map(result.rows.map((r) => [r.id, r]));
};

// Bulk tiers: the best (lowest) unit price whose threshold the quantity meets.
export const fetchBulkTiers = async (db: Queryable, productIds: number[]) => {
  const tiers = new Map<number, { min_quantity: number; price_per_unit: number }[]>();
  if (productIds.length === 0) return tiers;
  const result = await db.query(
    `SELECT product_id, min_quantity, price_per_unit FROM product_bulk_pricing
     WHERE product_id = ANY($1::int[]) ORDER BY product_id, min_quantity`,
    [productIds]
  );
  for (const row of result.rows) {
    const list = tiers.get(row.product_id) ?? [];
    list.push({ min_quantity: row.min_quantity, price_per_unit: Number(row.price_per_unit) });
    tiers.set(row.product_id, list);
  }
  return tiers;
};

const roundMoney = (n: number) => Math.round(n * 100) / 100;

export const unitPriceFor = (basePrice: number, quantity: number, tiers: { min_quantity: number; price_per_unit: number }[] = []) => {
  let price = basePrice;
  for (const t of tiers) {
    if (quantity >= t.min_quantity && t.price_per_unit < price) price = t.price_per_unit;
  }
  return price;
};

// Upper bound on quantity for one line: tracked stock, or the global ceiling if untracked.
export const maxQuantityFor = (p: Pick<ProductRow, "track_inventory" | "stock">) =>
  p.track_inventory ? Math.max(0, Math.min(p.stock, MAX_LINE_QUANTITY)) : MAX_LINE_QUANTITY;

export const lineIssue = (p: ProductRow | undefined, quantity: number): LineIssue | null => {
  if (!p || !p.is_active) return "UNAVAILABLE";
  if (p.track_inventory && p.stock <= 0) return "OUT_OF_STOCK";
  if (p.track_inventory && p.stock < quantity) return "INSUFFICIENT_STOCK";
  if (quantity < p.min_quantity) return "BELOW_MOQ";
  return null;
};

// Prices every line from database data only. Client-sent prices/totals are never read.
export const priceLines = async (
  db: Queryable,
  lines: { product_id: number; quantity: number }[],
  opts: { lock?: boolean } = {}
): Promise<PricedLine[]> => {
  const ids = [...new Set(lines.map((l) => l.product_id))];
  const [products, tiers] = await Promise.all([fetchProducts(db, ids, opts.lock), fetchBulkTiers(db, ids)]);

  return lines.map((line) => {
    const p = products.get(line.product_id);
    const issue = lineIssue(p, line.quantity);
    const basePrice = p ? Number(p.price) : 0;
    const unitPrice = p ? unitPriceFor(basePrice, line.quantity, tiers.get(p.id)) : 0;
    return {
      product_id: line.product_id,
      name: p?.name ?? "Product no longer available",
      sku: p?.sku ?? null,
      image: p?.image ?? null,
      quantity: line.quantity,
      base_price: basePrice,
      unit_price: unitPrice,
      compare_at_price: p?.compare_at_price != null ? Number(p.compare_at_price) : null,
      line_total: roundMoney(unitPrice * line.quantity),
      min_quantity: p?.min_quantity ?? 1,
      stock_available: p ? (p.track_inventory ? Math.max(0, p.stock) : null) : 0,
      is_available: issue === null,
      issue,
    };
  });
};

export const sumLines = (lines: PricedLine[]) =>
  roundMoney(lines.filter((l) => l.is_available).reduce((s, l) => s + l.line_total, 0));

// Shipping rule. The product page advertises free standard shipping above ₹999; the fee
// below that threshold is a business decision, so it is configuration (default ₹0) rather
// than a number invented in code.
export const computeShipping = (subtotal: number) => {
  const threshold = Number(process.env.FREE_SHIPPING_THRESHOLD ?? 999);
  const fee = Number(process.env.SHIPPING_FLAT_FEE ?? 0);
  if (subtotal <= 0) return 0;
  if (Number.isFinite(threshold) && subtotal >= threshold) return 0;
  return Number.isFinite(fee) && fee > 0 ? roundMoney(fee) : 0;
};

export { roundMoney };

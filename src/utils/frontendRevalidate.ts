import { NextFunction, Request, Response } from "express";

// Tells the Next.js storefront to drop its cached copy of catalogue data after an admin write,
// so product pages, category listings and sitemaps update immediately instead of after the
// storefront's ISR window. Fire-and-forget: a failure here never affects the admin response.
//
// Enabled only when both are set (no-op otherwise):
//   FRONTEND_REVALIDATE_URL  e.g. https://www.khazanagifting.in/api/revalidate
//   REVALIDATE_SECRET        same value as the storefront's REVALIDATE_SECRET

export interface RevalidatePayload {
  productIds?: number[];
  categories?: boolean;
  listings?: boolean;
  all?: boolean;
}

const toIds = (values: unknown[]) => values.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0);

export const notifyFrontend = (payload: RevalidatePayload) => {
  const url = process.env.FRONTEND_REVALIDATE_URL;
  const secret = process.env.REVALIDATE_SECRET;
  if (!url || !secret) return;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  })
    .then((r) => {
      if (!r.ok) console.warn(`[revalidate] storefront responded ${r.status}`);
    })
    .catch((err) => console.warn("[revalidate] storefront unreachable:", err?.message ?? err));
};

/**
 * Express middleware: after a successful (2xx/3xx) non-GET request, works out which storefront
 * caches are affected and notifies the storefront. `resolve` maps the request to a payload.
 */
export const revalidateOnWrite =
  (resolve: (req: Request) => RevalidatePayload | null) => (req: Request, res: Response, next: NextFunction) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    res.on("finish", () => {
      if (res.statusCode >= 400) return;
      try {
        const payload = resolve(req);
        if (payload) notifyFrontend(payload);
      } catch (err) {
        console.warn("[revalidate] could not resolve payload:", err);
      }
    });
    next();
  };

// /api/admin/* writes. Paths are relative to the admin router's mount point.
export const adminRevalidatePayload = (req: Request): RevalidatePayload | null => {
  const path = req.path;
  const body = (req.body ?? {}) as Record<string, any>;
  let m: RegExpMatchArray | null;

  if (path === "/products/bulk") return { productIds: toIds(Array.isArray(body.ids) ? body.ids : []), listings: true };
  if ((m = path.match(/^\/products\/(\d+)(?:\/duplicate)?$/))) return { productIds: toIds([m[1]]), listings: true };
  if (path === "/products") return { listings: true };
  if (path.startsWith("/categories")) return { categories: true, listings: true };
  if (path.startsWith("/brands")) return { all: true }; // brand names appear on product pages
  if (path === "/inventory/adjust") return { productIds: toIds([body.product_id]), listings: true };
  if (path === "/inventory/bulk") return { productIds: toIds(Array.isArray(body.items) ? body.items.map((i: any) => i?.product_id) : []), listings: true };
  return null; // orders, customers, uploads: no storefront impact
};

// Legacy /products/* write paths (incl. /products/:productId/images/*).
export const productRevalidatePayload = (req: Request): RevalidatePayload | null => {
  const m = req.path.match(/^\/(\d+)(?:\/|$)/);
  if (m) return { productIds: toIds([m[1]]), listings: true };
  return { listings: true, categories: true }; // create / bulk sheet import
};

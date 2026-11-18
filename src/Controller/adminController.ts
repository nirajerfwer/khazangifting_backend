import { Request, Response } from "express";
import { pagination } from "../middleware/validate";

import * as products from "../services/adminProductService";
import * as catalog from "../services/adminCatalogService";
import * as inventory from "../services/inventoryService";
import * as orders from "../services/adminOrderService";
import * as insights from "../services/adminInsightsService";

// Thin HTTP layer for the admin panel. Authorization is applied per route in adminRoutes.ts;
// the acting admin's id always comes from the verified JWT.

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : undefined;
};
const bool = (v: unknown) => (v === "true" ? true : v === "false" ? false : undefined);
const me = (req: Request) => req.user!.sub;

// ── Dashboard / search / alerts ──
export const dashboard = async (req: Request, res: Response) => {
  const days = [7, 30, 90].includes(Number(req.query.range)) ? Number(req.query.range) : 30;
  res.json({ success: true, data: await insights.getDashboard(days) });
};
export const alerts = async (_req: Request, res: Response) => {
  res.json({ success: true, data: await insights.getAlerts() });
};
export const search = async (req: Request, res: Response) => {
  const q = str(req.query.q);
  if (!q) return res.json({ success: true, data: { products: [], orders: [], customers: [] } });
  const canSeeCatalog = ["ADMIN", "SUPER_ADMIN"].includes(req.user!.role);
  res.json({ success: true, data: await insights.globalSearch(q, canSeeCatalog) });
};

// ── Products ──
const productFilters = (q: Request["query"]): products.ProductListFilters => ({
  q: str(q.q),
  category: num(q.category),
  brand: num(q.brand),
  status: str(q.status),
  featured: bool(q.featured),
  stock: str(q.stock),
  minPrice: num(q.minPrice),
  maxPrice: num(q.maxPrice),
  sort: str(q.sort),
});
export const listProducts = async (req: Request, res: Response) => {
  const { page, limit } = pagination(req.query, 20, 100);
  res.json({ success: true, ...(await products.listProducts(productFilters(req.query), page, limit)) });
};
export const exportProducts = async (req: Request, res: Response) => {
  const { csv } = await products.exportProductsCsv(productFilters(req.query));
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="products-${stamp}.csv"`);
  res.send(csv);
};
export const getProduct = async (req: Request, res: Response) => {
  res.json({ success: true, data: await products.getProduct(Number(req.params.id)) });
};
export const createProduct = async (req: Request, res: Response) => {
  res.status(201).json({ success: true, message: "Product created", data: await products.createProduct(me(req), req.body) });
};
export const updateProduct = async (req: Request, res: Response) => {
  res.json({ success: true, message: "Product saved", data: await products.updateProduct(me(req), Number(req.params.id), req.body) });
};
export const duplicateProduct = async (req: Request, res: Response) => {
  res.status(201).json({ success: true, message: "Product duplicated as draft", data: await products.duplicateProduct(me(req), Number(req.params.id)) });
};
export const deleteProduct = async (req: Request, res: Response) => {
  const r = await products.deleteProduct(me(req), Number(req.params.id));
  // `deactivated` stays a boolean for backward compatibility with the previous response shape.
  res.json({
    success: true,
    deleted: r.deleted > 0,
    deactivated: r.deactivated > 0,
    message: r.deleted ? "Product deleted" : "Product has orders, so it was deactivated instead of deleted",
  });
};
export const bulkProducts = async (req: Request, res: Response) => {
  res.json({ success: true, data: await products.bulkAction(me(req), req.body.ids, req.body.action) });
};

// ── Categories / brands / uploads ──
export const listCategories = async (_req: Request, res: Response) => {
  res.json({ success: true, data: await catalog.listCategories() });
};
export const createCategory = async (req: Request, res: Response) => {
  res.status(201).json({ success: true, message: "Category created", data: await catalog.createCategory(me(req), req.body) });
};
export const updateCategory = async (req: Request, res: Response) => {
  res.json({ success: true, message: "Category saved", data: await catalog.updateCategory(me(req), Number(req.params.id), req.body) });
};
export const deleteCategory = async (req: Request, res: Response) => {
  await catalog.deleteCategory(me(req), Number(req.params.id));
  res.json({ success: true, message: "Category deleted" });
};
export const listBrands = async (req: Request, res: Response) => {
  res.json({ success: true, data: await catalog.listBrands(str(req.query.q)) });
};
export const createBrand = async (req: Request, res: Response) => {
  res.status(201).json({ success: true, message: "Brand created", data: await catalog.createBrand(me(req), req.body) });
};
export const updateBrand = async (req: Request, res: Response) => {
  res.json({ success: true, message: "Brand saved", data: await catalog.updateBrand(me(req), Number(req.params.id), req.body) });
};
export const deleteBrand = async (req: Request, res: Response) => {
  await catalog.deleteBrand(me(req), Number(req.params.id));
  res.json({ success: true, message: "Brand deleted" });
};
export const presignUpload = async (req: Request, res: Response) => {
  res.json({ success: true, data: await catalog.presignAsset(req.body.folder, req.body.contentType) });
};

// ── Inventory ──
export const listInventory = async (req: Request, res: Response) => {
  const { page, limit } = pagination(req.query, 25, 100);
  res.json({ success: true, ...(await inventory.listInventory({ q: str(req.query.q), state: str(req.query.state), sort: str(req.query.sort) }, page, limit)) });
};
export const adjustStock = async (req: Request, res: Response) => {
  res.json({ success: true, message: "Stock updated", data: await inventory.adjustStock(me(req), req.body) });
};
export const bulkStock = async (req: Request, res: Response) => {
  res.json({ success: true, data: await inventory.bulkSetStock(me(req), req.body.items, req.body.reason, req.body.note) });
};
export const listMovements = async (req: Request, res: Response) => {
  const { page, limit } = pagination(req.query, 25, 100);
  res.json({ success: true, ...(await inventory.listMovements({ product_id: num(req.query.product_id), reason: str(req.query.reason) }, page, limit)) });
};

// ── Orders ──
export const listOrders = async (req: Request, res: Response) => {
  const { page, limit } = pagination(req.query, 20, 100);
  const q = req.query;
  res.json({
    success: true,
    ...(await orders.listOrders(
      { group: str(q.group), status: str(q.status), payment_status: str(q.payment_status), q: str(q.q), customer_id: str(q.customer_id), from: str(q.from), to: str(q.to), sort: str(q.sort) },
      page,
      limit
    )),
  });
};
export const getOrder = async (req: Request, res: Response) => {
  res.json({ success: true, data: await orders.getOrder(req.params.id as string) });
};
export const updateOrderStatus = async (req: Request, res: Response) => {
  res.json({ success: true, message: "Order updated", data: await orders.updateStatus(me(req), req.params.id as string, req.body) });
};

// ── Customers ──
export const listCustomers = async (req: Request, res: Response) => {
  const { page, limit } = pagination(req.query, 20, 100);
  res.json({ success: true, ...(await insights.listCustomers({ q: str(req.query.q), status: str(req.query.status), sort: str(req.query.sort) }, page, limit)) });
};
export const getCustomer = async (req: Request, res: Response) => {
  res.json({ success: true, data: await insights.getCustomer(req.params.id as string) });
};
export const setCustomerActive = async (req: Request, res: Response) => {
  res.json({ success: true, data: await insights.setCustomerActive(me(req), req.params.id as string, req.body.isActive) });
};



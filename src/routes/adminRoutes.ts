import express from "express";
import rateLimit from "express-rate-limit";
import * as admin from "../Controller/adminController";
import { requireAuth, requireRole } from "../middleware/auth";
import { validateBody, validateParam } from "../middleware/validate";
import {
  adminOrderStatusSchema,
  adminProductSchema,
  brandSchema,
  bulkProductSchema,
  bulkStockSchema,
  categorySchema,
  customerActiveSchema,
  presignSchema,
  stockAdjustSchema,
} from "../validators/adminValidator";

const adminRouter = express.Router();

// Role model (enforced here, not in the UI):
//  - ADMIN / SUPER_ADMIN: everything
//  - STAFF: dashboard, orders, inventory, read-only customers
const ADMINS = requireRole("ADMIN", "SUPER_ADMIN");
const STAFF = requireRole("ADMIN", "SUPER_ADMIN", "STAFF");

adminRouter.use(requireAuth, STAFF);

// Mutations get their own budget, separate from the global limiter.
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many changes in a short time, please slow down", code: "RATE_LIMITED" },
});
adminRouter.use((req, res, next) => (req.method === "GET" ? next() : writeLimiter(req, res, next)));

const intId = validateParam("id", "int");
const uuidId = validateParam("id", "uuid");

adminRouter.get("/dashboard", admin.dashboard);
adminRouter.get("/alerts", admin.alerts);
adminRouter.get("/search", admin.search);

// Products
adminRouter.get("/products", ADMINS, admin.listProducts);
adminRouter.get("/products/export", ADMINS, admin.exportProducts);
adminRouter.post("/products/bulk", ADMINS, validateBody(bulkProductSchema), admin.bulkProducts);
adminRouter.get("/products/:id", ADMINS, intId, admin.getProduct);
adminRouter.post("/products", ADMINS, validateBody(adminProductSchema), admin.createProduct);
adminRouter.put("/products/:id", ADMINS, intId, validateBody(adminProductSchema), admin.updateProduct);
adminRouter.post("/products/:id/duplicate", ADMINS, intId, admin.duplicateProduct);
adminRouter.delete("/products/:id", ADMINS, intId, admin.deleteProduct);

// Categories & brands
adminRouter.get("/categories", ADMINS, admin.listCategories);
adminRouter.post("/categories", ADMINS, validateBody(categorySchema), admin.createCategory);
adminRouter.put("/categories/:id", ADMINS, intId, validateBody(categorySchema), admin.updateCategory);
adminRouter.delete("/categories/:id", ADMINS, intId, admin.deleteCategory);
adminRouter.get("/brands", ADMINS, admin.listBrands);
adminRouter.post("/brands", ADMINS, validateBody(brandSchema), admin.createBrand);
adminRouter.put("/brands/:id", ADMINS, intId, validateBody(brandSchema), admin.updateBrand);
adminRouter.delete("/brands/:id", ADMINS, intId, admin.deleteBrand);
adminRouter.post("/uploads/presign", ADMINS, validateBody(presignSchema), admin.presignUpload);

// Inventory (staff can adjust stock)
adminRouter.get("/inventory", admin.listInventory);
adminRouter.post("/inventory/adjust", validateBody(stockAdjustSchema), admin.adjustStock);
adminRouter.post("/inventory/bulk", validateBody(bulkStockSchema), admin.bulkStock);
adminRouter.get("/inventory/movements", admin.listMovements);

// Orders
adminRouter.get("/orders", admin.listOrders);
adminRouter.get("/orders/:id", uuidId, admin.getOrder);
adminRouter.put("/orders/:id/status", uuidId, validateBody(adminOrderStatusSchema), admin.updateOrderStatus);

// Customers (staff can view; only admins can (de)activate)
adminRouter.get("/customers", admin.listCustomers);
adminRouter.get("/customers/:id", uuidId, admin.getCustomer);
adminRouter.put("/customers/:id/active", ADMINS, uuidId, validateBody(customerActiveSchema), admin.setCustomerActive);

export default adminRouter;

import express from "express";
import rateLimit from "express-rate-limit";
import { cancelMyOrder, createOrder, getCheckoutSummary, getMyOrderById, getMyOrders, payOrder } from "../Controller/orderController";
import { getOrder as adminGetOrder, listOrders as adminListOrders, updateOrderStatus as adminUpdateOrderStatus } from "../Controller/adminController";
import { requireAuth, requireRole } from "../middleware/auth";
import { validateBody, validateParam } from "../middleware/validate";
import { createOrderSchema } from "../validators/orderValidator";
import { adminOrderStatusSchema } from "../validators/adminValidator";

const orderRouter = express.Router();

// Order creation talks to the payment gateway; cap it per client to blunt abuse.
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many checkout attempts, please try again later", code: "RATE_LIMITED" },
});

orderRouter.use(requireAuth);

// Legacy admin paths, kept for backward compatibility; they share the /api/admin/orders handlers.
// Declared first so "/admin/..." is never captured by the customer "/:id" routes.
const staff = requireRole("ADMIN", "SUPER_ADMIN", "STAFF");
orderRouter.get("/admin/all", staff, adminListOrders);
orderRouter.get("/admin/:id", staff, validateParam("id", "uuid"), adminGetOrder);
orderRouter.put("/admin/:id/status", staff, validateParam("id", "uuid"), validateBody(adminOrderStatusSchema), adminUpdateOrderStatus);

orderRouter.get("/checkout/summary", getCheckoutSummary);
orderRouter.post("/", checkoutLimiter, validateBody(createOrderSchema), createOrder);
orderRouter.get("/", getMyOrders);
orderRouter.get("/:id", validateParam("id", "uuid"), getMyOrderById);
orderRouter.post("/:id/pay", checkoutLimiter, validateParam("id", "uuid"), payOrder);
orderRouter.post("/:id/cancel", validateParam("id", "uuid"), cancelMyOrder);

export default orderRouter;

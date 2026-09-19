import express from "express";
import { createOrder, getMyOrderById, getMyOrders, getOrderByIdAdmin, listOrders, updateOrderStatus } from "../Controller/orderController";
import { requireAuth, requireRole } from "../middleware/auth";
import { validateBody } from "../middleware/validate";
import { createOrderSchema, updateOrderStatusSchema } from "../validators/orderValidator";

const orderRouter = express.Router();

orderRouter.use(requireAuth);

orderRouter.post("/", validateBody(createOrderSchema), createOrder);
orderRouter.get("/", getMyOrders);
orderRouter.get("/:id", getMyOrderById);

orderRouter.get("/admin/all", requireRole("ADMIN", "SUPER_ADMIN", "STAFF"), listOrders);
orderRouter.get("/admin/:id", requireRole("ADMIN", "SUPER_ADMIN", "STAFF"), getOrderByIdAdmin);
orderRouter.put("/admin/:id/status", requireRole("ADMIN", "SUPER_ADMIN", "STAFF"), validateBody(updateOrderStatusSchema), updateOrderStatus);

export default orderRouter;

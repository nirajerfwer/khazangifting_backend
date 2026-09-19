import express from "express";
import { getDashboardSummary, listCustomers, setCustomerActive } from "../Controller/adminDashboardController";
import { requireAuth, requireRole } from "../middleware/auth";

const adminRouter = express.Router();

adminRouter.use(requireAuth, requireRole("ADMIN", "SUPER_ADMIN"));

adminRouter.get("/dashboard", getDashboardSummary);
adminRouter.get("/customers", listCustomers);
adminRouter.put("/customers/:id/active", setCustomerActive);

export default adminRouter;

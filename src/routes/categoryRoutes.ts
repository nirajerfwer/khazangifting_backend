import express from "express";
import { getCategorys } from "../Controller/CategoryController";
import { createCategory, deleteCategory, updateCategory } from "../Controller/adminController";
import { requireAuth, requireRole } from "../middleware/auth";
import { validateBody, validateParam } from "../middleware/validate";
import { categorySchema } from "../validators/adminValidator";
import { revalidateOnWrite } from "../utils/frontendRevalidate";

const Crouter = express.Router();
const adminOnly = [requireAuth, requireRole("ADMIN", "SUPER_ADMIN")];

Crouter.use(revalidateOnWrite(() => ({ categories: true, listings: true })));

Crouter.get("/", getCategorys);
// Legacy write paths, kept for backward compatibility; they share the /api/admin/categories handlers.
Crouter.post("/", ...adminOnly, validateBody(categorySchema), createCategory);
Crouter.put("/:id", ...adminOnly, validateParam("id", "int"), validateBody(categorySchema), updateCategory);
Crouter.delete("/:id", ...adminOnly, validateParam("id", "int"), deleteCategory);

export default Crouter;

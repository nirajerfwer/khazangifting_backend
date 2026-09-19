import express from "express";
import { createCategory, deleteCategory, getCategorys, updateCategory } from "../Controller/CategoryController";
import { requireAuth, requireRole } from "../middleware/auth";

const Crouter = express.Router();

Crouter.get("/", getCategorys);
Crouter.post("/", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), createCategory);
Crouter.put("/:id", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), updateCategory);
Crouter.delete("/:id", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), deleteCategory);

export default Crouter;
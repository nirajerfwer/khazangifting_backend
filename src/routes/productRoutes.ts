import express from "express";
import { createProductByLookingAtSheet, getProducts, getSingleProduct } from "../Controller/productController";
import { createProduct, deleteProduct, updateProduct } from "../Controller/adminController";
import { attachUserIfPresent, requireAuth, requireRole } from "../middleware/auth";
import { validateBody, validateParam } from "../middleware/validate";
import { adminProductSchema } from "../validators/adminValidator";
import productImageRoutes from "./productImageRoutes";
import { productRevalidatePayload, revalidateOnWrite } from "../utils/frontendRevalidate";

const Prouter = express.Router();
const adminOnly = [requireAuth, requireRole("ADMIN", "SUPER_ADMIN")];

// Successful writes (incl. image changes) refresh the storefront cache (no-op unless configured).
Prouter.use(revalidateOnWrite(productRevalidatePayload));

Prouter.use("/:productId/images", productImageRoutes);

Prouter.get("/", attachUserIfPresent, getProducts);
Prouter.get("/:id", attachUserIfPresent, getSingleProduct);
Prouter.post("/bulk/", ...adminOnly, createProductByLookingAtSheet);
// Legacy write paths, kept for backward compatibility; they share the /api/admin/products handlers.
Prouter.post("/", ...adminOnly, validateBody(adminProductSchema), createProduct);
Prouter.put("/:id", ...adminOnly, validateParam("id", "int"), validateBody(adminProductSchema), updateProduct);
Prouter.delete("/:id", ...adminOnly, validateParam("id", "int"), deleteProduct);

export default Prouter;

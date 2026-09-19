import express from "express";
import { createProduct, createProductByLookingAtSheet, deleteProduct, getProducts, getSingleProduct, updateProduct } from "../Controller/productController";
import { requireAuth, requireRole } from "../middleware/auth";

const Prouter = express.Router();

Prouter.get("/", getProducts);
Prouter.get("/:id", getSingleProduct);
Prouter.post("/", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), createProduct);
Prouter.put("/:id", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), updateProduct);
Prouter.delete("/:id", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), deleteProduct);
Prouter.post("/bulk/", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), createProductByLookingAtSheet);

export default Prouter;
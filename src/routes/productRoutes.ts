import express from "express";
import { createProduct, createProductByLookingAtSheet, deleteProduct, getProducts, getSingleProduct, updateProduct } from "../Controller/productController";


const Prouter = express.Router();

Prouter.get("/", getProducts);
Prouter.get("/:id", getSingleProduct);
Prouter.post("/", createProduct);
Prouter.put("/:id", updateProduct);
Prouter.delete("/:id", deleteProduct);
Prouter.post("/bulk/",createProductByLookingAtSheet);

export default Prouter;
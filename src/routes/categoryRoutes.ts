import express from "express";
import { createCategory, deleteCategory, getCategorys, updateCategory } from "../Controller/CategoryController";


const Crouter = express.Router();

Crouter.get("/", getCategorys);
Crouter.post("/", createCategory);
Crouter.put("/:id", updateCategory);
Crouter.delete("/:id", deleteCategory);

export default Crouter;
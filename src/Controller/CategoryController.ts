import { Request, Response } from "express";
import { pool } from "../database/db";

// GET all categories
export const getCategorys = async (req: Request, res: Response) => {
  try {
    const result = await pool.query(`SELECT 
  cat.name,cat.id,
  COUNT(pc.product_id) AS product_count
FROM categories AS cat
JOIN product_categories AS pc 
  ON cat.id = pc.category_id
GROUP BY cat.id, cat.name;`);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch categories" });
  }
};

// CREATE Category
export const createCategory = async (req: Request, res: Response) => {
  const { name} = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO categories (name)
       VALUES ($1) RETURNING *`,
      [name]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: "Failed to create Category" });
  }
};

// UPDATE Category
export const updateCategory = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name } = req.body;

  try {
    const result = await pool.query(
      `UPDATE categories 
       SET name=$1
       WHERE id=$2 RETURNING *`,
      [name,id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: "Failed to update Category" });
  }
};

// DELETE Category
export const deleteCategory = async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    await pool.query("DELETE FROM categories WHERE id=$1", [id]);
    res.json({ message: "Category deleted" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete Category" });
  }
};
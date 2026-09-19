import { Request, Response } from "express";
import { pool } from "../database/db";

export const updateProfile = async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const { name } = req.body;

  try {
    const result = await pool.query(
      "UPDATE users SET name=$1, updated_at=NOW() WHERE id=$2 RETURNING id, name, email, role, created_at",
      [name, userId]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to update profile", code: "SERVER_ERROR" });
  }
};

export const listAddresses = async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  try {
    const result = await pool.query(
      "SELECT * FROM addresses WHERE user_id=$1 ORDER BY is_default DESC, created_at DESC",
      [userId]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch addresses", code: "SERVER_ERROR" });
  }
};

export const createAddress = async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const { fullName, phone, line1, line2, city, state, pincode, isDefault } = req.body;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (isDefault) {
      await client.query("UPDATE addresses SET is_default = FALSE WHERE user_id=$1", [userId]);
    }
    const result = await client.query(
      `INSERT INTO addresses (user_id, full_name, phone, line1, line2, city, state, pincode, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [userId, fullName, phone, line1, line2 ?? null, city, state, pincode, Boolean(isDefault)]
    );
    await client.query("COMMIT");
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(500).json({ success: false, message: "Failed to create address", code: "SERVER_ERROR" });
  } finally {
    client.release();
  }
};

export const updateAddress = async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const { id } = req.params;
  const { fullName, phone, line1, line2, city, state, pincode, isDefault } = req.body;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (isDefault) {
      await client.query("UPDATE addresses SET is_default = FALSE WHERE user_id=$1", [userId]);
    }
    const result = await client.query(
      `UPDATE addresses SET full_name=$1, phone=$2, line1=$3, line2=$4, city=$5, state=$6, pincode=$7, is_default=$8
       WHERE id=$9 AND user_id=$10 RETURNING *`,
      [fullName, phone, line1, line2 ?? null, city, state, pincode, Boolean(isDefault), id, userId]
    );
    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Address not found", code: "NOT_FOUND" });
    }
    await client.query("COMMIT");
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(500).json({ success: false, message: "Failed to update address", code: "SERVER_ERROR" });
  } finally {
    client.release();
  }
};

export const deleteAddress = async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const { id } = req.params;

  try {
    const result = await pool.query("DELETE FROM addresses WHERE id=$1 AND user_id=$2 RETURNING id", [id, userId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Address not found", code: "NOT_FOUND" });
    }
    res.json({ success: true, message: "Address deleted" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to delete address", code: "SERVER_ERROR" });
  }
};

import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../database/db";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../utils/jwt";

const isProd = process.env.NODE_ENV === "production";

const refreshCookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: "lax" as const,
  path: "/api/auth",
  maxAge: 30 * 24 * 60 * 60 * 1000,
};

export const register = async (req: Request, res: Response) => {
  const { name, email, password } = req.body;

  try {
    const existing = await pool.query("SELECT id FROM users WHERE email=$1", [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, message: "Email already registered", code: "EMAIL_EXISTS" });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users (name, email, password, role) VALUES ($1, $2, $3, 'CUSTOMER')
       RETURNING id, name, email, role, created_at`,
      [name, email, passwordHash]
    );

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("register error:", error);
    res.status(500).json({ success: false, message: "Failed to register", code: "SERVER_ERROR" });
  }
};

export const login = async (req: Request, res: Response) => {
  const { email, password } = req.body;

  try {
    const result = await pool.query(
      "SELECT id, name, email, password, role, is_active FROM users WHERE email=$1",
      [email]
    );

    const user = result.rows[0];
    // Generic message regardless of which check fails — don't reveal whether the email exists.
    if (!user || !user.is_active) {
      return res.status(401).json({ success: false, message: "Invalid email or password", code: "INVALID_CREDENTIALS" });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ success: false, message: "Invalid email or password", code: "INVALID_CREDENTIALS" });
    }

    const payload = { sub: user.id as string, role: user.role };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    res.cookie("refreshToken", refreshToken, refreshCookieOptions);
    res.json({
      success: true,
      data: {
        accessToken,
        user: { id: user.id, name: user.name, email: user.email, role: user.role },
      },
    });
  } catch (error) {
    console.error("login error:", error);
    res.status(500).json({ success: false, message: "Failed to login", code: "SERVER_ERROR" });
  }
};

export const refresh = async (req: Request, res: Response) => {
  const token = req.cookies?.refreshToken;
  if (!token) {
    return res.status(401).json({ success: false, message: "No refresh token", code: "NO_REFRESH_TOKEN" });
  }

  try {
    const payload = verifyRefreshToken(token);
    const accessToken = signAccessToken({ sub: payload.sub, role: payload.role });
    res.json({ success: true, data: { accessToken } });
  } catch {
    return res.status(401).json({ success: false, message: "Invalid or expired refresh token", code: "INVALID_REFRESH_TOKEN" });
  }
};

export const logout = async (_req: Request, res: Response) => {
  res.clearCookie("refreshToken", { path: "/api/auth" });
  res.json({ success: true, message: "Logged out" });
};

export const me = async (req: Request, res: Response) => {
  try {
    const result = await pool.query("SELECT id, name, email, role, created_at FROM users WHERE id=$1", [req.user!.sub]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch profile" });
  }
};

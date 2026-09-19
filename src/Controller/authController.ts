import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { pool } from "../database/db";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../utils/jwt";
import { sendPasswordResetEmail } from "../utils/mailer";

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

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

export const changePassword = async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const { currentPassword, newPassword } = req.body;

  try {
    const result = await pool.query("SELECT password FROM users WHERE id=$1", [userId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const valid = await bcrypt.compare(currentPassword, result.rows[0].password);
    if (!valid) {
      return res.status(401).json({ success: false, message: "Current password is incorrect", code: "INVALID_CREDENTIALS" });
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    await pool.query("UPDATE users SET password=$1, updated_at=NOW() WHERE id=$2", [newHash, userId]);

    // Revoke the old refresh token so other sessions must re-authenticate.
    res.clearCookie("refreshToken", { path: "/api/auth" });
    res.json({ success: true, message: "Password changed successfully. Please log in again." });
  } catch (error) {
    console.error("changePassword error:", error);
    res.status(500).json({ success: false, message: "Failed to change password", code: "SERVER_ERROR" });
  }
};

export const forgotPassword = async (req: Request, res: Response) => {
  const { email } = req.body;
  const genericResponse = { success: true, message: "If an account with that email exists, a reset link has been sent." };

  try {
    const user = await pool.query("SELECT id FROM users WHERE email=$1 AND is_active=TRUE", [email]);
    if (user.rows.length === 0) {
      return res.json(genericResponse); // don't reveal whether the email exists
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

    await pool.query(
      "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
      [user.rows[0].id, hashToken(rawToken), expiresAt]
    );

    await sendPasswordResetEmail(email, rawToken);

    res.json(genericResponse);
  } catch (error) {
    console.error("forgotPassword error:", error);
    res.json(genericResponse); // still don't leak errors that would confirm account existence
  }
};

export const resetPassword = async (req: Request, res: Response) => {
  const { token, newPassword } = req.body;

  try {
    const tokenHash = hashToken(token);
    const result = await pool.query(
      `SELECT id, user_id FROM password_reset_tokens
       WHERE token_hash=$1 AND used_at IS NULL AND expires_at > NOW()`,
      [tokenHash]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ success: false, message: "Invalid or expired reset token", code: "INVALID_TOKEN" });
    }

    const { id: tokenId, user_id: userId } = result.rows[0];
    const newHash = await bcrypt.hash(newPassword, 12);

    await pool.query("UPDATE users SET password=$1, updated_at=NOW() WHERE id=$2", [newHash, userId]);
    await pool.query("UPDATE password_reset_tokens SET used_at=NOW() WHERE id=$1", [tokenId]);
    // Invalidate any other outstanding reset tokens for this user.
    await pool.query("UPDATE password_reset_tokens SET used_at=NOW() WHERE user_id=$1 AND used_at IS NULL", [userId]);

    res.json({ success: true, message: "Password reset successfully" });
  } catch (error) {
    console.error("resetPassword error:", error);
    res.status(500).json({ success: false, message: "Failed to reset password", code: "SERVER_ERROR" });
  }
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

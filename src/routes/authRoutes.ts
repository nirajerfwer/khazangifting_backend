import express from "express";
import rateLimit from "express-rate-limit";
import { changePassword, forgotPassword, login, logout, me, refresh, register, resetPassword } from "../Controller/authController";
import { requireAuth } from "../middleware/auth";
import { validateBody } from "../middleware/validate";
import { changePasswordSchema, forgotPasswordSchema, resetPasswordSchema } from "../validators/accountValidator";
import { loginSchema, registerSchema } from "../validators/authValidator";

const authRouter = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many login attempts, please try again later", code: "RATE_LIMITED" },
});

const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests, please try again later", code: "RATE_LIMITED" },
});

// Limits scripted account creation / email enumeration via the "already registered" response.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many accounts created, please try again later", code: "RATE_LIMITED" },
});

authRouter.post("/register", registerLimiter, validateBody(registerSchema), register);
authRouter.post("/login", loginLimiter, validateBody(loginSchema), login);
authRouter.post("/refresh", refresh);
authRouter.post("/logout", logout);
authRouter.get("/me", requireAuth, me);
authRouter.post("/change-password", requireAuth, validateBody(changePasswordSchema), changePassword);
authRouter.post("/forgot-password", forgotPasswordLimiter, validateBody(forgotPasswordSchema), forgotPassword);
authRouter.post("/reset-password", validateBody(resetPasswordSchema), resetPassword);

export default authRouter;

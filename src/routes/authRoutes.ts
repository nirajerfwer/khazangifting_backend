import express from "express";
import rateLimit from "express-rate-limit";
import { login, logout, me, refresh, register } from "../Controller/authController";
import { requireAuth } from "../middleware/auth";
import { validateBody } from "../middleware/validate";
import { loginSchema, registerSchema } from "../validators/authValidator";

const authRouter = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many login attempts, please try again later", code: "RATE_LIMITED" },
});

authRouter.post("/register", validateBody(registerSchema), register);
authRouter.post("/login", loginLimiter, validateBody(loginSchema), login);
authRouter.post("/refresh", refresh);
authRouter.post("/logout", logout);
authRouter.get("/me", requireAuth, me);

export default authRouter;

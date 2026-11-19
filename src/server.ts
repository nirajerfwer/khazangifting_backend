import express, { NextFunction, Request, Response } from "express";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import { timingSafeEqual } from "crypto";
import Prouter from "./routes/productRoutes";
import cartRoutes from "./routes/cartRoutes";
import wishlistRoutes from "./routes/wishlistRoutes";
import Crouter from "./routes/categoryRoutes";
import Blogrouter from "./routes/blogsRoutes";
import authRouter from "./routes/authRoutes";
import orderRouter from "./routes/orderRoutes";
import adminRouter from "./routes/adminRoutes";
import paymentRouter from "./routes/paymentRoutes";
import accountRouter from "./routes/accountRoutes";
import { razorpayWebhook } from "./Controller/paymentController";
import { HttpError } from "./utils/httpError";

dotenv.config();

const app = express();

app.use(helmet());

// Webhook needs the raw request body to verify Razorpay's signature, so it must be
// registered before the global express.json() parser consumes the stream.
app.post("/api/payments/webhook", express.raw({ type: "application/json" }), razorpayWebhook);

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.use(
  cors({
    origin: ["http://localhost:3000", process.env.FRONTEND as string],
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  })
);

// The Next.js storefront renders product/category pages on its servers, so every search-engine
// crawl of the site arrives here from a handful of storefront IPs. Requests carrying the shared
// INTERNAL_API_KEY are exempt from the per-IP limit so crawlers never receive 429/5xx pages.
// Disabled unless INTERNAL_API_KEY is set (to a long random value) on both services.
const internalKey = process.env.INTERNAL_API_KEY ? Buffer.from(process.env.INTERNAL_API_KEY) : null;
const isInternalRequest = (req: Request) => {
  const provided = req.get("x-internal-api-key");
  if (!internalKey || !provided) return false;
  const p = Buffer.from(provided);
  return p.length === internalKey.length && timingSafeEqual(p, internalKey);
};

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    skip: isInternalRequest,
  })
);

app.use("/api/auth", authRouter);
app.use("/api/cart", cartRoutes);
app.use("/api/wishlist", wishlistRoutes);
app.use("/api/orders", orderRouter);
app.use("/api/admin", adminRouter);
app.use("/api/payments", paymentRouter);
app.use("/api/account", accountRouter);
app.use("/products", Prouter);
app.use("/category", Crouter);
app.use("/blog", Blogrouter);

app.get("/", (req: Request, res: Response) => {
  res.json({ Message: "Working" });
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ success: false, message: "Not found", code: "NOT_FOUND" });
});

// Centralized error handler — never leak stack traces to clients.
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  // Expected, client-facing errors from the service layer.
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      success: false,
      message: err.message,
      code: err.code,
      ...(err.details !== undefined ? { details: err.details } : {}),
    });
  }
  // Malformed JSON bodies from express.json().
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ success: false, message: "Malformed JSON body", code: "BAD_REQUEST" });
  }
  console.error(`[${req.method} ${req.originalUrl}]`, err);
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  res.status(status).json({
    success: false,
    message: status < 500 ? err.message : process.env.NODE_ENV === "production" ? "Internal server error" : err?.message || "Internal server error",
    code: status < 500 ? "BAD_REQUEST" : "SERVER_ERROR",
  });
});

const startServer = async () => {
  app.listen(process.env.PORT || 5000, () => {
    console.log(`Server running on http://localhost:${process.env.PORT || 5000}`);
  });
};

startServer();

import express, { NextFunction, Request, Response } from "express";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import Prouter from "./routes/productRoutes";
import cartRoutes from "./routes/cartRoutes";
import wishlistRoutes from "./routes/wishlistRoutes";
import Crouter from "./routes/categoryRoutes";
import Blogrouter from "./routes/blogsRoutes";
import authRouter from "./routes/authRoutes";
import orderRouter from "./routes/orderRoutes";
import adminRouter from "./routes/adminRoutes";
import paymentRouter from "./routes/paymentRoutes";
import { razorpayWebhook } from "./Controller/paymentController";

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

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.use("/api/auth", authRouter);
app.use("/api/cart", cartRoutes);
app.use("/api/wishlist", wishlistRoutes);
app.use("/api/orders", orderRouter);
app.use("/api/admin", adminRouter);
app.use("/api/payments", paymentRouter);
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
  console.error(err);
  res.status(err?.status || 500).json({
    success: false,
    message: process.env.NODE_ENV === "production" ? "Internal server error" : err?.message || "Internal server error",
    code: "SERVER_ERROR",
  });
});

const startServer = async () => {
  app.listen(process.env.PORT || 5000, () => {
    console.log(`Server running on http://localhost:${process.env.PORT || 5000}`);
  });
};

startServer();

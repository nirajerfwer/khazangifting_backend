import express from "express";
import { verifyPayment } from "../Controller/paymentController";
import { requireAuth } from "../middleware/auth";
import { validateBody } from "../middleware/validate";
import { verifyPaymentSchema } from "../validators/paymentValidator";

const paymentRouter = express.Router();

paymentRouter.post("/verify", requireAuth, validateBody(verifyPaymentSchema), verifyPayment);

export default paymentRouter;

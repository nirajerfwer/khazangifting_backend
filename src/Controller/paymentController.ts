import { Request, Response } from "express";
import { pool } from "../database/db";
import { verifyPaymentSignature, verifyWebhookSignature } from "../utils/razorpay";
import { recordAuditLog } from "../utils/auditLog";

// Marks an order PAID only after independently verifying Razorpay's signature —
// the frontend's "payment succeeded" callback is never trusted on its own.
// Idempotent: only transitions orders still in PENDING_PAYMENT, so retries/double-clicks
// on an already-paid order are safely ignored rather than double-processed.
export const verifyPayment = async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  try {
    let valid: boolean;
    try {
      valid = verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
    } catch {
      valid = false;
    }

    if (!valid) {
      return res.status(400).json({ success: false, message: "Invalid payment signature", code: "INVALID_SIGNATURE" });
    }

    const result = await pool.query(
      `UPDATE orders
       SET status = 'PAID', razorpay_payment_id = $1, updated_at = NOW()
       WHERE razorpay_order_id = $2 AND user_id = $3 AND status = 'PENDING_PAYMENT'
       RETURNING *`,
      [razorpay_payment_id, razorpay_order_id, userId]
    );

    if (result.rows.length === 0) {
      // Either the order doesn't belong to this user, doesn't exist, or was already processed.
      const existing = await pool.query("SELECT status FROM orders WHERE razorpay_order_id=$1 AND user_id=$2", [razorpay_order_id, userId]);
      if (existing.rows.length > 0 && existing.rows[0].status === "PAID") {
        return res.json({ success: true, message: "Payment already verified" });
      }
      return res.status(404).json({ success: false, message: "Order not found or not payable", code: "NOT_FOUND" });
    }

    await pool.query("INSERT INTO order_status_history (order_id, status, changed_by) VALUES ($1, 'PAID', $2)", [result.rows[0].id, userId]);
    await recordAuditLog(userId, "PAYMENT_VERIFIED", "order", result.rows[0].id);

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("verifyPayment error:", error);
    res.status(500).json({ success: false, message: "Failed to verify payment", code: "SERVER_ERROR" });
  }
};

// Razorpay webhook — a second, independent confirmation path in case the browser
// never returns after payment (closed tab, network drop). Verifies the webhook
// signature (separate secret from the checkout signature) and is idempotent
// via the same PENDING_PAYMENT guard.
export const razorpayWebhook = async (req: Request, res: Response) => {
  const signature = req.headers["x-razorpay-signature"] as string | undefined;
  const rawBody: Buffer = req.body;

  if (!signature) {
    return res.status(400).json({ success: false, message: "Missing signature" });
  }

  try {
    if (!verifyWebhookSignature(rawBody.toString("utf8"), signature)) {
      return res.status(400).json({ success: false, message: "Invalid webhook signature" });
    }
  } catch {
    return res.status(400).json({ success: false, message: "Invalid webhook signature" });
  }

  try {
    const event = JSON.parse(rawBody.toString("utf8"));

    if (event.event === "payment.captured") {
      const payment = event.payload.payment.entity;
      await pool.query(
        `UPDATE orders
         SET status = 'PAID', razorpay_payment_id = $1, updated_at = NOW()
         WHERE razorpay_order_id = $2 AND status = 'PENDING_PAYMENT'`,
        [payment.id, payment.order_id]
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error("razorpayWebhook error:", error);
    res.status(500).json({ success: false, message: "Webhook processing failed" });
  }
};

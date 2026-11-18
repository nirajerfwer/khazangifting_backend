import { Request, Response } from "express";
import { pool } from "../database/db";
import { verifyPaymentSignature, verifyWebhookSignature } from "../utils/razorpay";
import { recordAuditLog } from "../utils/auditLog";

// Transitions an order to PAID exactly once. The `status = 'PENDING_PAYMENT'` guard makes this
// idempotent across the browser callback, the webhook, and retries; status history is written
// in the same transaction so the audit trail can't diverge from the order row.
const markOrderPaid = async (razorpayOrderId: string, razorpayPaymentId: string, userId: string | null) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE orders
       SET status = 'PAID', payment_status = 'PAID', razorpay_payment_id = $1, updated_at = NOW()
       WHERE razorpay_order_id = $2 AND status = 'PENDING_PAYMENT' ${userId ? "AND user_id = $3" : ""}
       RETURNING id, user_id, status, payment_status, total_amount`,
      userId ? [razorpayPaymentId, razorpayOrderId, userId] : [razorpayPaymentId, razorpayOrderId]
    );
    if (result.rows.length > 0) {
      await client.query("INSERT INTO order_status_history (order_id, status, changed_by) VALUES ($1, 'PAID', $2)", [
        result.rows[0].id,
        userId,
      ]);
    }
    await client.query("COMMIT");
    return result.rows[0] ?? null;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

// Marks an order PAID only after independently verifying Razorpay's signature —
// the frontend's "payment succeeded" callback is never trusted on its own.
export const verifyPayment = async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  let valid: boolean;
  try {
    valid = verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
  } catch {
    valid = false;
  }
  if (!valid) {
    return res.status(400).json({ success: false, message: "Invalid payment signature", code: "INVALID_SIGNATURE" });
  }

  const paid = await markOrderPaid(razorpay_order_id, razorpay_payment_id, userId);
  if (!paid) {
    // Either the order doesn't belong to this user, doesn't exist, or was already processed.
    const existing = await pool.query("SELECT id, status FROM orders WHERE razorpay_order_id=$1 AND user_id=$2", [razorpay_order_id, userId]);
    if (existing.rows.length > 0 && existing.rows[0].status !== "PENDING_PAYMENT" && existing.rows[0].status !== "CANCELLED") {
      return res.json({ success: true, message: "Payment already verified", data: { id: existing.rows[0].id, status: existing.rows[0].status } });
    }
    return res.status(404).json({ success: false, message: "Order not found or not payable", code: "NOT_FOUND" });
  }

  await recordAuditLog(userId, "PAYMENT_VERIFIED", "order", paid.id);
  res.json({ success: true, data: paid });
};

// Razorpay webhook — a second, independent confirmation path in case the browser
// never returns after payment (closed tab, network drop). Verifies the webhook
// signature (separate secret from the checkout signature) and is idempotent.
export const razorpayWebhook = async (req: Request, res: Response) => {
  const signature = req.headers["x-razorpay-signature"] as string | undefined;
  const rawBody = req.body;

  if (!signature || !Buffer.isBuffer(rawBody)) {
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
    const payment = event?.payload?.payment?.entity;

    if ((event.event === "payment.captured" || event.event === "order.paid") && payment?.order_id) {
      const paid = await markOrderPaid(payment.order_id, payment.id, null);
      if (paid) await recordAuditLog(undefined, "PAYMENT_WEBHOOK_CAPTURED", "order", paid.id);
    } else if (event.event === "payment.failed" && payment?.order_id) {
      // The order stays PENDING_PAYMENT so the customer can retry; we only record the failure.
      await pool.query(
        `UPDATE orders SET payment_status = 'FAILED', updated_at = NOW()
         WHERE razorpay_order_id = $1 AND status = 'PENDING_PAYMENT'`,
        [payment.order_id]
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error("razorpayWebhook error:", error);
    res.status(500).json({ success: false, message: "Webhook processing failed" });
  }
};

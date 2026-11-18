import { Request, Response } from "express";
import { pagination } from "../middleware/validate";
import * as orderService from "../services/orderService";

// Customer-facing handlers are thin wrappers over services/orderService. The user id always
// comes from the verified JWT; prices/totals are recomputed server-side from the database.

export const getCheckoutSummary = async (req: Request, res: Response) => {
  res.json({ success: true, data: await orderService.getCheckoutSummary(req.user!.sub) });
};

export const createOrder = async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const { order, items, duplicate } = await orderService.createOrder(userId, req.body);

  // Payment initialisation is attempted right away for convenience; if the gateway is down
  // the order still exists (PENDING_PAYMENT) and the client can retry via POST /:id/pay.
  let payment: Awaited<ReturnType<typeof orderService.preparePayment>> | null = null;
  let paymentError: string | null = null;
  if (order.status === "PENDING_PAYMENT") {
    try {
      payment = await orderService.preparePayment(userId, order.id);
    } catch (err: any) {
      paymentError = err?.message ?? "Could not start payment";
    }
  }

  res.status(duplicate ? 200 : 201).json({
    success: true,
    data: {
      ...order,
      items,
      duplicate,
      payment,
      paymentError,
      // Backward-compatible fields from the previous response shape.
      razorpayOrderId: payment?.razorpayOrderId ?? null,
      razorpayKeyId: payment?.razorpayKeyId ?? null,
    },
  });
};

export const payOrder = async (req: Request, res: Response) => {
  res.json({ success: true, data: await orderService.preparePayment(req.user!.sub, req.params.id as string) });
};

export const cancelMyOrder = async (req: Request, res: Response) => {
  res.json({ success: true, message: "Order cancelled", data: await orderService.cancelOwnOrder(req.user!.sub, req.params.id as string) });
};

export const getMyOrders = async (req: Request, res: Response) => {
  const { page, limit } = pagination(req.query, 10, 50);
  const result = await orderService.listMyOrders(req.user!.sub, page, limit);
  res.json({ success: true, ...result });
};

export const getMyOrderById = async (req: Request, res: Response) => {
  res.json({ success: true, data: await orderService.getMyOrder(req.user!.sub, req.params.id as string) });
};

import { z } from "zod";

export const createOrderSchema = z.object({
  shippingAddress: z.object({
    fullName: z.string().trim().min(1).max(150),
    phone: z.string().trim().min(6).max(20),
    line1: z.string().trim().min(1).max(255),
    line2: z.string().trim().max(255).optional(),
    city: z.string().trim().min(1).max(100),
    state: z.string().trim().min(1).max(100),
    pincode: z.string().trim().min(3).max(20),
  }),
});

export const updateOrderStatusSchema = z.object({
  status: z.enum([
    "PENDING_PAYMENT",
    "PAID",
    "PROCESSING",
    "PACKED",
    "SHIPPED",
    "DELIVERED",
    "CANCELLED",
    "REFUNDED",
  ]),
});

import { z } from "zod";

const addressObject = z.object({
  fullName: z.string().trim().min(1).max(150),
  phone: z.string().trim().min(6).max(20),
  line1: z.string().trim().min(1).max(255),
  line2: z.string().trim().max(255).optional(),
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().min(1).max(100),
  pincode: z.string().trim().min(3).max(20),
});

// Either a saved address id (ownership is verified server-side) or an inline address.
// Totals/prices are intentionally not part of this schema.
export const createOrderSchema = z
  .object({
    shippingAddress: addressObject.optional(),
    addressId: z.number().int().positive().optional(),
    billingAddress: addressObject.optional(),
    billingAddressId: z.number().int().positive().optional(),
    idempotencyKey: z.string().uuid().optional(),
  })
  .refine((v) => v.shippingAddress || v.addressId, { message: "shippingAddress or addressId is required", path: ["shippingAddress"] });

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

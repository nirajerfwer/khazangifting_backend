import { z } from "zod";
import { MAX_LINE_QUANTITY } from "../services/catalogService";

const productId = z.coerce.number().int().positive();
const quantity = z.coerce.number().int().min(1).max(MAX_LINE_QUANTITY);

// Only product id + quantity are accepted. Any price/total/user_id a client sends is
// stripped by zod (unknown keys are dropped) and never reaches the service layer.
export const addToCartSchema = z.object({
  product_id: productId,
  quantity: quantity.default(1),
});

export const updateCartQuantitySchema = z.object({
  quantity,
});

export const guestCartSchema = z.object({
  items: z.array(z.object({ product_id: productId, quantity })).max(100),
});

export const moveFromWishlistSchema = z.object({
  product_id: productId,
  removeFromWishlist: z.boolean().optional().default(true),
});

export const wishlistProductSchema = z.object({
  product_id: productId,
});

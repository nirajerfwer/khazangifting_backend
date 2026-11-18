import express from "express";
import {
  addToCart,
  clearCart,
  getCart,
  mergeGuestCart,
  moveWishlistToCart,
  previewGuestCart,
  removeFromCart,
  updateCartQuantity,
} from "../Controller/cartController";
import { requireAuth } from "../middleware/auth";
import { validateBody, validateParam } from "../middleware/validate";
import { addToCartSchema, guestCartSchema, moveFromWishlistSchema, updateCartQuantitySchema } from "../validators/cartValidator";

const cartRoutes = express.Router();

// Public: guest cart pricing (no user data involved).
cartRoutes.post("/preview", validateBody(guestCartSchema), previewGuestCart);

cartRoutes.use(requireAuth);

cartRoutes.get("/", getCart);
cartRoutes.post("/add", validateBody(addToCartSchema), addToCart);
cartRoutes.put("/update/:cart_item_id", validateParam("cart_item_id", "int"), validateBody(updateCartQuantitySchema), updateCartQuantity);
cartRoutes.delete("/remove/:cart_item_id", validateParam("cart_item_id", "int"), removeFromCart);
cartRoutes.delete("/", clearCart);
cartRoutes.post("/merge", validateBody(guestCartSchema), mergeGuestCart);
cartRoutes.post("/move-from-wishlist", validateBody(moveFromWishlistSchema), moveWishlistToCart);

export default cartRoutes;

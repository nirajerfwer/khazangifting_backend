import express from "express";
import { addToCart, getCart, moveWishlistToCart, removeFromCart, updateCartQuantity } from "../Controller/cartController";
import { requireAuth } from "../middleware/auth";

const cartRoutes = express.Router();

cartRoutes.use(requireAuth);

cartRoutes.get("/", getCart);
cartRoutes.post("/add", addToCart);
cartRoutes.delete("/remove/:cart_item_id", removeFromCart);
cartRoutes.put("/update/:cart_item_id", updateCartQuantity);
cartRoutes.post("/move-from-wishlist", moveWishlistToCart);

export default cartRoutes;

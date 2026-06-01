import express from "express";
import { addToCart, getCart, moveWishlistToCart, removeFromCart, updateCartQuantity } from "../Controller/cartController";

const cartRoutes = express.Router();

cartRoutes.get("/:user_id", getCart);
cartRoutes.post("/add", addToCart);
cartRoutes.delete("/remove/:cart_item_id", removeFromCart);
cartRoutes.put("/update/:cart_item_id", updateCartQuantity);
cartRoutes.post("/move-from-wishlist", moveWishlistToCart);

export default cartRoutes;
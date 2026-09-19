import express from "express";
import { addToWishlist, getWishlist, removeFromWishlist } from "../Controller/wishlistController";
import { requireAuth } from "../middleware/auth";

const wishlistRoutes = express.Router();

wishlistRoutes.use(requireAuth);

wishlistRoutes.post("/add", addToWishlist);
wishlistRoutes.get("/", getWishlist);
wishlistRoutes.delete("/remove/:wishlist_item_id", removeFromWishlist);

export default wishlistRoutes;

import express from "express";
import { addToWishlist, getWishlist, removeFromWishlist } from "../Controller/wishlistController";

const wishlistRoutes = express.Router();

wishlistRoutes.post("/add", addToWishlist);
wishlistRoutes.get("/:user_id", getWishlist);
wishlistRoutes.delete("/remove/:wishlist_item_id", removeFromWishlist);

export default wishlistRoutes;
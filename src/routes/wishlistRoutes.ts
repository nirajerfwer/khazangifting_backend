import express from "express";
import {
  addToWishlist,
  getWishlist,
  getWishlistIds,
  getWishlistStatus,
  removeFromWishlist,
  removeProductFromWishlist,
} from "../Controller/wishlistController";
import { requireAuth } from "../middleware/auth";
import { validateBody, validateParam } from "../middleware/validate";
import { wishlistProductSchema } from "../validators/cartValidator";

const wishlistRoutes = express.Router();

wishlistRoutes.use(requireAuth);

wishlistRoutes.get("/", getWishlist);
wishlistRoutes.get("/ids", getWishlistIds);
wishlistRoutes.get("/status/:product_id", validateParam("product_id", "int"), getWishlistStatus);
wishlistRoutes.post("/add", validateBody(wishlistProductSchema), addToWishlist);
wishlistRoutes.delete("/remove/:wishlist_item_id", validateParam("wishlist_item_id", "int"), removeFromWishlist);
wishlistRoutes.delete("/product/:product_id", validateParam("product_id", "int"), removeProductFromWishlist);

export default wishlistRoutes;

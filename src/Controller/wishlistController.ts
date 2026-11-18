import { Request, Response } from "express";
import { pagination } from "../middleware/validate";
import * as wishlistService from "../services/wishlistService";

export const addToWishlist = async (req: Request, res: Response) => {
  const result = await wishlistService.addProduct(req.user!.sub, req.body.product_id);
  res.status(result.added ? 201 : 200).json({
    success: true,
    message: result.added ? "Added to wishlist" : "Already in wishlist",
    data: result,
  });
};

export const getWishlist = async (req: Request, res: Response) => {
  const { page, limit } = pagination(req.query, 20, 50);
  res.json({ success: true, data: await wishlistService.listItems(req.user!.sub, page, limit) });
};

export const getWishlistIds = async (req: Request, res: Response) => {
  res.json({ success: true, data: await wishlistService.listProductIds(req.user!.sub) });
};

export const getWishlistStatus = async (req: Request, res: Response) => {
  const inWishlist = await wishlistService.isInWishlist(req.user!.sub, Number(req.params.product_id));
  res.json({ success: true, data: { product_id: Number(req.params.product_id), inWishlist } });
};

export const removeFromWishlist = async (req: Request, res: Response) => {
  const removed = await wishlistService.removeByItemId(req.user!.sub, Number(req.params.wishlist_item_id));
  res.json({ success: true, message: "Item removed from wishlist", data: removed });
};

export const removeProductFromWishlist = async (req: Request, res: Response) => {
  const removed = await wishlistService.removeByProductId(req.user!.sub, Number(req.params.product_id));
  res.json({ success: true, message: "Item removed from wishlist", data: removed });
};

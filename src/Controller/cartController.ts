import { Request, Response } from "express";
import * as cartService from "../services/cartService";

// Thin HTTP layer: the user id always comes from the verified JWT (req.user), never from the
// body; business rules live in services/cartService. Express 5 forwards thrown/rejected
// errors to the central error handler in server.ts.

export const getCart = async (req: Request, res: Response) => {
  res.json({ success: true, data: await cartService.getCart(req.user!.sub) });
};

export const addToCart = async (req: Request, res: Response) => {
  const { product_id, quantity } = req.body;
  const cart = await cartService.addItem(req.user!.sub, product_id, quantity);
  res.json({ success: true, message: "Added to cart", data: cart });
};

export const updateCartQuantity = async (req: Request, res: Response) => {
  const cart = await cartService.updateItemQuantity(req.user!.sub, Number(req.params.cart_item_id), req.body.quantity);
  res.json({ success: true, data: cart });
};

export const removeFromCart = async (req: Request, res: Response) => {
  const cart = await cartService.removeItem(req.user!.sub, Number(req.params.cart_item_id));
  res.json({ success: true, message: "Item removed from cart", data: cart });
};

export const clearCart = async (req: Request, res: Response) => {
  const cart = await cartService.clearCart(req.user!.sub);
  res.json({ success: true, message: "Cart cleared", data: cart });
};

export const mergeGuestCart = async (req: Request, res: Response) => {
  const result = await cartService.mergeGuestCart(req.user!.sub, req.body.items);
  res.json({ success: true, data: result.cart, skipped: result.skipped });
};

// Public: prices a guest's browser-held cart from the database.
export const previewGuestCart = async (req: Request, res: Response) => {
  res.json({ success: true, data: await cartService.previewGuestCart(req.body.items) });
};

export const moveWishlistToCart = async (req: Request, res: Response) => {
  const { product_id, removeFromWishlist } = req.body;
  const cart = await cartService.moveFromWishlist(req.user!.sub, product_id, removeFromWishlist);
  res.json({ success: true, message: "Moved to cart successfully", data: cart });
};

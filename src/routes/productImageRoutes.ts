import express from "express";
import {
  confirmImage,
  deleteImage,
  getUploadUrl,
  listImages,
  reorderImages,
  setPrimaryImage,
  updateImageAlt,
} from "../Controller/productImageController";
import { requireAuth, requireRole } from "../middleware/auth";
import { validateBody, validateParam } from "../middleware/validate";
import { confirmImageSchema, imageAltSchema, presignImageSchema, reorderImagesSchema } from "../validators/productImageValidator";

const router = express.Router({ mergeParams: true });

const adminOnly = [requireAuth, requireRole("ADMIN", "SUPER_ADMIN")];
const productId = validateParam("productId", "int");
const imageId = validateParam("imageId", "int");

router.get("/", productId, listImages);
router.post("/upload-url", ...adminOnly, productId, validateBody(presignImageSchema), getUploadUrl);
router.post("/confirm", ...adminOnly, productId, validateBody(confirmImageSchema), confirmImage);
router.put("/reorder", ...adminOnly, productId, validateBody(reorderImagesSchema), reorderImages);
router.put("/:imageId/primary", ...adminOnly, productId, imageId, setPrimaryImage);
router.put("/:imageId", ...adminOnly, productId, imageId, validateBody(imageAltSchema), updateImageAlt);
router.delete("/:imageId", ...adminOnly, productId, imageId, deleteImage);

export default router;

import express from "express";
import {
  confirmImage,
  deleteImage,
  getUploadUrl,
  listImages,
  reorderImages,
  setPrimaryImage,
} from "../Controller/productImageController";
import { requireAuth, requireRole } from "../middleware/auth";
import { validateBody } from "../middleware/validate";
import { confirmImageSchema, presignImageSchema, reorderImagesSchema } from "../validators/productImageValidator";

const router = express.Router({ mergeParams: true });

const adminOnly = [requireAuth, requireRole("ADMIN", "SUPER_ADMIN")];

router.get("/", listImages);
router.post("/upload-url", ...adminOnly, validateBody(presignImageSchema), getUploadUrl);
router.post("/confirm", ...adminOnly, validateBody(confirmImageSchema), confirmImage);
router.put("/reorder", ...adminOnly, validateBody(reorderImagesSchema), reorderImages);
router.put("/:imageId/primary", ...adminOnly, setPrimaryImage);
router.delete("/:imageId", ...adminOnly, deleteImage);

export default router;

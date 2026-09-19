import { z } from "zod";
import { ALLOWED_IMAGE_TYPES } from "../utils/s3";

export const presignImageSchema = z.object({
  contentType: z.enum(ALLOWED_IMAGE_TYPES),
});

export const confirmImageSchema = z.object({
  key: z.string().min(1).max(500),
  altText: z.string().trim().max(255).optional(),
  isPrimary: z.boolean().optional(),
});

export const reorderImagesSchema = z.object({
  order: z.array(z.number().int().positive()).min(1),
});

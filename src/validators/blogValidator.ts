import { z } from "zod";

const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const createBlogSchema = z.object({
  title: z.string().trim().min(1).max(255),
  slug: z.string().trim().toLowerCase().min(1).max(255).regex(slugRegex, "Slug must be lowercase, alphanumeric, hyphen-separated"),
  excerpt: z.string().trim().max(500).optional(),
  content: z.string().trim().min(1),
  cover_image: z.string().trim().url().max(1000).optional(),
  published: z.boolean().optional(),
});

export const updateBlogSchema = createBlogSchema.partial();

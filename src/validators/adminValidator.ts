import { z } from "zod";
import { ALLOWED_IMAGE_TYPES } from "../utils/s3";

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .max(180)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase letters, numbers and hyphens");
const money = z.coerce.number().min(0).max(99999999);
const optText = (max: number) => z.string().trim().max(max).optional().nullable();
const id = z.coerce.number().int().positive();

// ── Products ──
const attributes = z
  .object({
    size: optText(100),
    color: optText(100),
    material: optText(100),
    weight: optText(50),
    dimensions: optText(100),
    custom: z.array(z.object({ name: z.string().trim().min(1).max(60), value: z.string().trim().max(200) })).max(30).optional(),
  })
  .partial()
  .optional();

export const adminProductSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    slug: slug.optional().nullable().or(z.literal("")),
    sku: optText(100),
    short_description: optText(500),
    description: optText(20000),
    brand_id: id.optional().nullable(),
    category_ids: z.array(id).max(20).optional().default([]),
    product_type: optText(50),
    price: money,
    compare_at_price: money.optional().nullable(),
    cost_price: money.optional().nullable(),
    gst_rate: z.coerce.number().min(0).max(100).optional().nullable(),
    hsn_code: z.string().trim().regex(/^[0-9]{0,8}$/, "HSN must be up to 8 digits").optional().nullable(),
    stock: z.coerce.number().int().min(0).max(10000000).optional().default(0),
    track_inventory: z.boolean().optional().default(false),
    low_stock_threshold: z.coerce.number().int().min(0).max(100000).optional().default(5),
    status: z.enum(["DRAFT", "ACTIVE", "INACTIVE"]).optional().default("ACTIVE"),
    is_featured: z.boolean().optional().default(false),
    attributes,
    seo_title: optText(255),
    seo_description: optText(500),
  })
  .refine((v) => v.compare_at_price == null || v.compare_at_price === 0 || v.compare_at_price >= v.price, {
    message: "MRP must be greater than or equal to the selling price",
    path: ["compare_at_price"],
  });

export const bulkProductSchema = z.object({
  ids: z.array(id).min(1).max(200),
  action: z.enum(["activate", "deactivate", "draft", "feature", "unfeature", "delete"]),
});

// ── Categories & brands ──
export const categorySchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: slug.optional().nullable().or(z.literal("")),
  parent_id: id.optional().nullable(),
  description: optText(2000),
  image_key: z.string().max(300).optional().nullable(),
  remove_image: z.boolean().optional(),
  is_active: z.boolean().optional().default(true),
  seo_title: optText(255),
  seo_description: optText(500),
  sort_order: z.coerce.number().int().min(0).max(100000).optional().default(0),
});

export const brandSchema = z.object({
  name: z.string().trim().min(1).max(150),
  slug: slug.optional().nullable().or(z.literal("")),
  description: optText(2000),
  logo_key: z.string().max(300).optional().nullable(),
  remove_logo: z.boolean().optional(),
  is_active: z.boolean().optional().default(true),
});

export const presignSchema = z.object({
  folder: z.enum(["categories", "brands"]),
  contentType: z.enum(ALLOWED_IMAGE_TYPES),
});

// ── Inventory ──
export const stockAdjustSchema = z.object({
  product_id: id,
  mode: z.enum(["set", "delta"]),
  quantity: z.coerce.number().int().min(-10000000).max(10000000),
  reason: z.enum(["ADJUSTMENT", "RESTOCK", "DAMAGE", "CORRECTION"]),
  note: optText(500),
  track_inventory: z.boolean().optional(),
});

export const bulkStockSchema = z.object({
  items: z.array(z.object({ product_id: id, stock: z.coerce.number().int().min(0).max(10000000) })).min(1).max(200),
  reason: z.enum(["ADJUSTMENT", "RESTOCK", "CORRECTION"]).default("ADJUSTMENT"),
  note: optText(500),
});

// ── Orders & customers ──
export const adminOrderStatusSchema = z.object({
  status: z.enum(["PENDING_PAYMENT", "PAID", "PROCESSING", "PACKED", "SHIPPED", "DELIVERED", "CANCELLED", "RETURNED", "REFUNDED"]),
  note: optText(1000),
  tracking_number: optText(100),
  courier: optText(100),
  refund_amount: money.optional().nullable(),
  refund_reference: optText(100),
});

export const customerActiveSchema = z.object({ isActive: z.boolean() });

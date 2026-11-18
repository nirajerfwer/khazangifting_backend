import { Request, Response } from "express";
import { pool, withTransaction } from "../database/db";
import { buildPublicUrl, deleteS3Object, generatePresignedUpload } from "../utils/s3";
import { recordAuditLog } from "../utils/auditLog";

// Step 1: admin asks the backend for a presigned S3 POST for a given product + content type.
export const getUploadUrl = async (req: Request, res: Response) => {
  const productId = req.params.productId as string;
  const { contentType } = req.body;

  try {
    const product = await pool.query("SELECT id FROM products WHERE id=$1", [productId]);
    if (product.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found", code: "NOT_FOUND" });
    }

    const presigned = await generatePresignedUpload({ folder: "products", entityId: productId, contentType });
    res.json({ success: true, data: presigned });
  } catch (error: any) {
    if (error.status === 422) {
      return res.status(422).json({ success: false, message: error.message, code: "UNSUPPORTED_TYPE" });
    }
    console.error("getUploadUrl error:", error);
    res.status(500).json({ success: false, message: "Failed to create upload URL", code: "SERVER_ERROR" });
  }
};

// Step 2: after the browser uploads directly to S3, the admin confirms it so we persist metadata.
export const confirmImage = async (req: Request, res: Response) => {
  const productId = req.params.productId;
  const { key, altText, isPrimary } = req.body;

  // The key must belong to this product's folder — prevents attaching an arbitrary S3 object.
  if (!key.startsWith(`products/${productId}/`)) {
    return res.status(422).json({ success: false, message: "Key does not match product", code: "KEY_MISMATCH" });
  }

  try {
    const image = await withTransaction(async (client) => {
      if (isPrimary) {
        await client.query("UPDATE product_images SET is_primary = FALSE WHERE product_id=$1", [productId]);
      }

      const imageUrl = buildPublicUrl(key);

      const sortResult = await client.query(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM product_images WHERE product_id=$1",
        [productId]
      );

      const result = await client.query(
        `INSERT INTO product_images (product_id, s3_key, image_url, alt_text, sort_order, is_primary)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [productId, key, imageUrl, altText ?? null, sortResult.rows[0].next, Boolean(isPrimary)]
      );
      return result.rows[0];
    });
    // Audit only after the transaction released its connection (avoids pool starvation).
    await recordAuditLog(req.user!.sub, "CREATE", "product_image", image.id, { productId });

    res.status(201).json({ success: true, data: image });
  } catch (error) {
    console.error("confirmImage error:", error);
    res.status(500).json({ success: false, message: "Failed to save image", code: "SERVER_ERROR" });
  }
};

export const listImages = async (req: Request, res: Response) => {
  const productId = req.params.productId;
  try {
    const result = await pool.query(
      "SELECT id, s3_key, image_url, alt_text, sort_order, is_primary, created_at FROM product_images WHERE product_id=$1 ORDER BY sort_order ASC",
      [productId]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch images", code: "SERVER_ERROR" });
  }
};

export const deleteImage = async (req: Request, res: Response) => {
  const { productId, imageId } = req.params;

  try {
    const existing = await pool.query(
      "SELECT s3_key FROM product_images WHERE id=$1 AND product_id=$2",
      [imageId, productId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Image not found", code: "NOT_FOUND" });
    }

    await pool.query("DELETE FROM product_images WHERE id=$1", [imageId]);

    // Only delete from S3 once no DB row references this key any more.
    const stillReferenced = await pool.query("SELECT 1 FROM product_images WHERE s3_key=$1", [existing.rows[0].s3_key]);
    if (stillReferenced.rows.length === 0) {
      await deleteS3Object(existing.rows[0].s3_key);
    }

    await recordAuditLog(req.user!.sub, "DELETE", "product_image", imageId as string, { productId });
    res.json({ success: true, message: "Image deleted" });
  } catch (error) {
    console.error("deleteImage error:", error);
    res.status(500).json({ success: false, message: "Failed to delete image", code: "SERVER_ERROR" });
  }
};

// Updates the alt text of an existing image (SEO / accessibility).
export const updateImageAlt = async (req: Request, res: Response) => {
  const { productId, imageId } = req.params;
  try {
    const r = await pool.query(
      "UPDATE product_images SET alt_text=$1 WHERE id=$2 AND product_id=$3 RETURNING id, image_url, alt_text, sort_order, is_primary",
      [req.body.altText ?? null, imageId, productId]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: "Image not found", code: "NOT_FOUND" });
    res.json({ success: true, data: r.rows[0] });
  } catch (error) {
    console.error("updateImageAlt error:", error);
    res.status(500).json({ success: false, message: "Failed to update image", code: "SERVER_ERROR" });
  }
};

export const setPrimaryImage = async (req: Request, res: Response) => {
  const { productId, imageId } = req.params;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT id FROM product_images WHERE id=$1 AND product_id=$2", [imageId, productId]);
    if (existing.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Image not found", code: "NOT_FOUND" });
    }

    await client.query("UPDATE product_images SET is_primary = FALSE WHERE product_id=$1", [productId]);
    await client.query("UPDATE product_images SET is_primary = TRUE WHERE id=$1", [imageId]);
    await client.query("COMMIT");

    res.json({ success: true, message: "Primary image updated" });
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(500).json({ success: false, message: "Failed to set primary image", code: "SERVER_ERROR" });
  } finally {
    client.release();
  }
};

export const reorderImages = async (req: Request, res: Response) => {
  const { productId } = req.params;
  const { order } = req.body as { order: number[] };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < order.length; i++) {
      await client.query(
        "UPDATE product_images SET sort_order=$1 WHERE id=$2 AND product_id=$3",
        [i, order[i], productId]
      );
    }
    await client.query("COMMIT");
    res.json({ success: true, message: "Order updated" });
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(500).json({ success: false, message: "Failed to reorder images", code: "SERVER_ERROR" });
  } finally {
    client.release();
  }
};

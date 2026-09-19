import { Request, Response } from "express";
import { pool } from "../database/db";
import { recordAuditLog } from "../utils/auditLog";

// GET all blogs (paginated). Public callers only see published posts.
export const getBlogs = async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, parseInt(req.query.limit as string) || 10);
    const offset = (page - 1) * limit;

    const includeUnpublished = Boolean(req.user && ["ADMIN", "SUPER_ADMIN", "STAFF"].includes(req.user.role));
    const whereClause = includeUnpublished ? "" : "WHERE b.published = TRUE";

    const result = await pool.query(
      `SELECT b.id, b.title, b.slug, b.excerpt, b.cover_image, b.published, b.published_at, b.created_at, b.updated_at
       FROM blogs AS b
       ${whereClause}
       ORDER BY b.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const totalResult = await pool.query(`SELECT COUNT(*) FROM blogs AS b ${whereClause}`);
    const total = parseInt(totalResult.rows[0].count, 10);

    res.json({
      success: true,
      data: result.rows,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("getBlogs error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch blogs", code: "SERVER_ERROR" });
  }
};

// GET single blog by slug
export const getBlogBySlug = async (req: Request, res: Response) => {
  const { slug } = req.params;

  try {
    const includeUnpublished = Boolean(req.user && ["ADMIN", "SUPER_ADMIN", "STAFF"].includes(req.user.role));
    const whereClause = includeUnpublished ? "b.slug = $1" : "b.slug = $1 AND b.published = TRUE";

    const result = await pool.query(
      `SELECT b.id, b.title, b.slug, b.excerpt, b.content, b.cover_image, b.published, b.published_at, b.created_at, b.updated_at
       FROM blogs AS b
       WHERE ${whereClause}`,
      [slug]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Blog not found", code: "NOT_FOUND" });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("getBlogBySlug error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch blog", code: "SERVER_ERROR" });
  }
};

// GET single blog by id (admin only — includes unpublished/drafts, used for the edit form)
export const getBlogByIdAdmin = async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT b.id, b.title, b.slug, b.excerpt, b.content, b.cover_image, b.published, b.published_at, b.created_at, b.updated_at
       FROM blogs AS b
       WHERE b.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Blog not found", code: "NOT_FOUND" });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("getBlogByIdAdmin error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch blog", code: "SERVER_ERROR" });
  }
};

// CREATE Blog (admin only, body validated by validateBody(createBlogSchema))
export const createBlog = async (req: Request, res: Response) => {
  const { title, slug, excerpt, content, cover_image, published } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO blogs (title, slug, excerpt, content, cover_image, author_id, published, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7 THEN NOW() ELSE NULL END)
       RETURNING id, title, slug, excerpt, cover_image, published, published_at, created_at, updated_at`,
      [title, slug, excerpt ?? null, content, cover_image ?? null, req.user!.sub, published ?? false]
    );

    const blog = result.rows[0];
    await recordAuditLog(req.user!.sub, "CREATE", "blog", blog.id);

    res.status(201).json({ success: true, data: blog });
  } catch (error: any) {
    if (error?.code === "23505") {
      return res.status(409).json({ success: false, message: "Slug already exists", code: "SLUG_EXISTS" });
    }
    console.error("createBlog error:", error);
    res.status(500).json({ success: false, message: "Failed to create blog", code: "SERVER_ERROR" });
  }
};

// UPDATE Blog (admin only, body validated by validateBody(updateBlogSchema))
export const updateBlog = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { title, slug, excerpt, content, cover_image, published } = req.body;

  try {
    const result = await pool.query(
      `UPDATE blogs
       SET title = COALESCE($1, title),
           slug = COALESCE($2, slug),
           excerpt = COALESCE($3, excerpt),
           content = COALESCE($4, content),
           cover_image = COALESCE($5, cover_image),
           published = COALESCE($6, published),
           published_at = CASE WHEN $6 = TRUE AND published_at IS NULL THEN NOW() ELSE published_at END,
           updated_at = NOW()
       WHERE id = $7
       RETURNING id, title, slug, excerpt, cover_image, published, published_at, created_at, updated_at`,
      [title ?? null, slug ?? null, excerpt ?? null, content ?? null, cover_image ?? null, published ?? null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Blog not found", code: "NOT_FOUND" });
    }

    await recordAuditLog(req.user!.sub, "UPDATE", "blog", id as string);

    res.json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    if (error?.code === "23505") {
      return res.status(409).json({ success: false, message: "Slug already exists", code: "SLUG_EXISTS" });
    }
    console.error("updateBlog error:", error);
    res.status(500).json({ success: false, message: "Failed to update blog", code: "SERVER_ERROR" });
  }
};

// DELETE Blog (admin only)
export const deleteBlog = async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const result = await pool.query("DELETE FROM blogs WHERE id=$1 RETURNING id", [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Blog not found", code: "NOT_FOUND" });
    }

    await recordAuditLog(req.user!.sub, "DELETE", "blog", id as string);

    res.json({ success: true, message: "Blog deleted successfully" });
  } catch (error) {
    console.error("deleteBlog error:", error);
    res.status(500).json({ success: false, message: "Failed to delete blog", code: "SERVER_ERROR" });
  }
};

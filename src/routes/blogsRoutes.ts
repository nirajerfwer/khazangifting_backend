import express from "express";
import { createBlog, deleteBlog, getBlogBySlug, getBlogs, updateBlog } from "../Controller/BlogsController";
import { requireAuth, requireRole } from "../middleware/auth";
import { validateBody } from "../middleware/validate";
import { createBlogSchema, updateBlogSchema } from "../validators/blogValidator";

const Blogrouter = express.Router();

const optionalAuth = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
  const header = req.headers.authorization;
  if (!header) return next();
  requireAuth(req, _res, next);
};

Blogrouter.get("/", optionalAuth, getBlogs);
Blogrouter.get("/:slug", optionalAuth, getBlogBySlug);
Blogrouter.post("/", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), validateBody(createBlogSchema), createBlog);
Blogrouter.put("/:id", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), validateBody(updateBlogSchema), updateBlog);
Blogrouter.delete("/:id", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), deleteBlog);

export default Blogrouter;

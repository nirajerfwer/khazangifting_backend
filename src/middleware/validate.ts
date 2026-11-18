import { NextFunction, Request, Response } from "express";
import { ZodType } from "zod";

export const validateBody = (schema: ZodType) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(422).json({
        success: false,
        message: "Validation failed",
        code: "VALIDATION_ERROR",
        errors: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    req.body = result.data;
    next();
  };
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Rejects malformed path params up front so they 404 cleanly instead of surfacing as a
// database cast error (500). `kind` picks the expected format.
export const validateParam = (name: string, kind: "uuid" | "int") => {
  return (req: Request, res: Response, next: NextFunction) => {
    const value = String(req.params[name] ?? "");
    const ok = kind === "uuid" ? UUID_RE.test(value) : /^[1-9]\d{0,9}$/.test(value);
    if (!ok) {
      return res.status(404).json({ success: false, message: "Not found", code: "NOT_FOUND" });
    }
    next();
  };
};

// Parses ?page=&limit= with sane bounds.
export const pagination = (query: Record<string, unknown>, defaultLimit: number, maxLimit: number) => {
  const page = Math.max(1, parseInt(String(query.page ?? ""), 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(String(query.limit ?? ""), 10) || defaultLimit));
  return { page, limit };
};

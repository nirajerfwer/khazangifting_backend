import { NextFunction, Request, Response } from "express";
import { JwtPayload, JwtRole, verifyAccessToken } from "../utils/jwt";

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : req.cookies?.accessToken;

  if (!token) {
    return res.status(401).json({ success: false, message: "Authentication required", code: "NO_TOKEN" });
  }

  try {
    req.user = verifyAccessToken(token);
    next();
  } catch {
    return res.status(401).json({ success: false, message: "Invalid or expired token", code: "INVALID_TOKEN" });
  }
};

// Attaches req.user when a valid token is present but never rejects: for public endpoints
// that return extra data to staff (e.g. inactive products in the admin product list).
export const attachUserIfPresent = (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : req.cookies?.accessToken;
  if (token) {
    try {
      req.user = verifyAccessToken(token);
    } catch {
      // Invalid/expired token on a public route: treat as anonymous.
    }
  }
  next();
};

export const isStaff = (req: Request) => !!req.user && ["ADMIN", "SUPER_ADMIN", "STAFF"].includes(req.user.role);

export const requireRole =(...roles: JwtRole[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Authentication required", code: "NO_TOKEN" });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: "Insufficient permissions", code: "FORBIDDEN" });
    }
    next();
  };
};

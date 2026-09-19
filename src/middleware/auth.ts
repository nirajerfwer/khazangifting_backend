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

export const requireRole = (...roles: JwtRole[]) => {
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

import type { NextFunction, Request, Response } from "express";

import { AuthService, parseAuthToken } from "./auth.service";

export interface AuthedRequest extends Request {
  authUser?: { username: string };
}

/**
 * Express 层全局认证：必须放在 useStaticAssets / Swagger 挂载之前，
 * 因为 Nest 的 useGlobalGuards 拦不到这两类 Express 中间件处理的请求。
 * 唯一放行 POST /auth/login；CORS 预检（OPTIONS）不携带 Cookie，直接放行。
 */
export function createAuthMiddleware(authService: AuthService) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (req.method === "OPTIONS") return next();
    if (req.method === "POST" && req.path === "/auth/login") return next();

    const token = parseAuthToken(req.headers.cookie);
    const user = token ? authService.verifyToken(token) : null;
    if (!user) {
      res.status(401).json({ data: {}, message: "未登录或登录已过期" });
      return;
    }

    req.authUser = user;
    next();
  };
}

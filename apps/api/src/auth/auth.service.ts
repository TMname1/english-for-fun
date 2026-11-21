import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export const AUTH_COOKIE_NAME = "auth_token";
export const AUTH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// 生产前端（CF Pages）与 API（Tunnel 子域）跨站，Cookie 必须 SameSite=None; Secure 才会被浏览器携带
const isProd = process.env.NODE_ENV === "prod";

export const authCookieOptions = {
  httpOnly: true,
  sameSite: (isProd ? "none" : "lax") as "none" | "lax",
  secure: isProd,
  path: "/",
  maxAge: AUTH_TOKEN_TTL_MS,
};

export interface AuthUser {
  username: string;
}

@Injectable()
export class AuthService {
  private readonly username: string;
  private readonly password: string;
  private readonly secret: string;

  constructor(config: ConfigService) {
    this.username = config.getOrThrow<string>("AUTH_USERNAME");
    this.password = config.getOrThrow<string>("AUTH_PASSWORD");
    this.secret = config.getOrThrow<string>("SECRET");
  }

  verifyCredentials(username: string, password: string): boolean {
    return safeEqual(username, this.username) && safeEqual(password, this.password);
  }

  issueToken(): string {
    const payload = Buffer.from(
      JSON.stringify({ u: this.username, e: Date.now() + AUTH_TOKEN_TTL_MS }),
    ).toString("base64url");
    return `${payload}.${this.sign(payload)}`;
  }

  verifyToken(token: string): AuthUser | null {
    const dot = token.lastIndexOf(".");
    if (dot <= 0) return null;

    const payload = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    if (!safeEqual(signature, this.sign(payload))) return null;

    try {
      const { u, e } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      if (typeof u !== "string" || typeof e !== "number") return null;
      if (u !== this.username || e < Date.now()) return null;
      return { username: u };
    } catch {
      return null;
    }
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }
}

// 先哈希再比较，避免 timingSafeEqual 对长度不一致抛错，也掩盖长度差异
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function parseAuthToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === AUTH_COOKIE_NAME) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

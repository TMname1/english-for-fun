// Cookie 持久化：登录成功后把 B 站的 SESSDATA 等 cookie 存到 cookies.json。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIE_FILE = path.resolve(__dirname, "..", "..", "cookies.json");

export function loadCookies() {
  try {
    return JSON.parse(fs.readFileSync(COOKIE_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function saveCookies(obj) {
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(obj, null, 2), "utf8");
  return COOKIE_FILE;
}

// 从 Set-Cookie 头数组里解析出 name=value 合并进现有 jar。
export function mergeSetCookies(jar, setCookieHeaders) {
  for (const line of setCookieHeaders) {
    const pair = line.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value) jar[name] = value;
    else delete jar[name];
  }
  return jar;
}

export function cookieString(jar = loadCookies()) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

export const cookieFilePath = COOKIE_FILE;

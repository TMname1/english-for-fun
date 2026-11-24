import { randomUUID } from "node:crypto";

import { cookieString, parseCookieString } from "./storage.js";

// HTTP 层：复刻原项目主进程的 onBeforeSendHeaders 鉴权头改写。
// B 站 CDN(bilivideo.com) 靠 Referer/UA 防盗链，这里统一注入。
export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36";
export const REFERER = "https://www.bilibili.com";

export function biliHeaders(extra = {}) {
  return {
    "User-Agent": UA,
    Referer: REFERER,
    ...extra,
  };
}

// 取回响应里的所有 Set-Cookie（Node 19+），登录轮询用。
export function setCookies(res) {
  if (typeof res.headers.getSetCookie === "function") return res.headers.getSetCookie();
  const raw = res.headers.get("set-cookie");
  return raw ? [raw] : [];
}

// API 请求默认超时（ms），防止 B 站服务不可达时无限期挂起
export const DEFAULT_TIMEOUT_MS = 15_000;

export async function fetchJson(
  url,
  { headers = {}, method = "GET", timeout = DEFAULT_TIMEOUT_MS } = {},
) {
  const res = await fetch(url, {
    method,
    headers: biliHeaders(headers),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
  const json = await res.json();
  if (json.code !== undefined && json.code !== 0 && json.code !== 200) {
    // 部分接口用 code 表达业务错误
    if (json.code !== -1) throw new Error(`API code=${json.code} ${json.message || ""} @ ${url}`);
  }
  return json;
}

// 服务器（机房 IP）裸调 web-interface 接口会被 B 站风控成 HTTP 412，带上访客指纹 buvid3 即放行；
// 家宽 IP 不挑这条，所以只在云端复现。值取自 finger/spi，进程内取一次全程复用。
const SPI_URL = "https://api.bilibili.com/x/frontend/finger/spi";
let buvid3Promise = null;

async function fetchBuvid3() {
  const res = await fetch(SPI_URL, {
    headers: biliHeaders(),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${SPI_URL}`);
  const b3 = (await res.json())?.data?.b_3;
  if (!b3) throw new Error(`SPI 响应里没有 b_3 @ ${SPI_URL}`);
  return b3;
}

export function getBuvid3() {
  if (!buvid3Promise) {
    // SPI 自身被风控/不可达时按官方格式造一个，实测同样能过
    buvid3Promise = fetchBuvid3().catch(() => `${randomUUID().toUpperCase()}infoc`);
  }
  return buvid3Promise;
}

/** 把访客指纹并进 Cookie 头；调用方已带 buvid3 时以调用方的为准。 */
export async function withBuvid3(cookieStr = "") {
  const jar = parseCookieString(cookieStr);
  if (jar.buvid3) return cookieStr;
  jar.buvid3 = await getBuvid3();
  return cookieString(jar);
}

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

export async function fetchJson(url, { headers = {}, method = "GET" } = {}) {
  const res = await fetch(url, { method, headers: biliHeaders(headers) });
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
  const json = await res.json();
  if (json.code !== undefined && json.code !== 0 && json.code !== 200) {
    // 部分接口用 code 表达业务错误
    if (json.code !== -1) throw new Error(`API code=${json.code} ${json.message || ""} @ ${url}`);
  }
  return json;
}

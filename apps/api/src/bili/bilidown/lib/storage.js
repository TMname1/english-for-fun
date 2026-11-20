// Cookie 工具：纯函数，只负责 jar（name→value 对象）与 Cookie 头字符串之间的转换。
// 持久化已上移到调用方注入的异步 cookieStore（服务端用数据库，CLI 默认读 BILI_COOKIE 环境变量）。
export function cookieString(jar = {}) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

// 把 "k=v; k2=v2" 形式的 Cookie 头解析回 jar 对象。
export function parseCookieString(str = "") {
  const jar = {};
  for (const part of String(str).split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name && value) jar[name] = value;
  }
  return jar;
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

// WBI 签名：playurl 等接口现在要求带 w_rid/wts。
// 原项目 1.2.7 走的是免签名老参数；这里补上签名以保证今天仍可下载。
import { createHash } from "node:crypto";

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54,
  21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

function getMixinKey(imgKey, subKey) {
  const orig = imgKey + subKey;
  return MIXIN_KEY_ENC_TAB.map((n) => orig[n] || "")
    .join("")
    .slice(0, 32);
}

function urlEncode(str) {
  return encodeURIComponent(String(str)).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

// 从 nav 接口的 wbi_img.url 里取 img_key/sub_key
export function extractWbiKeys(navData) {
  const { img_url = "", sub_url = "" } = navData?.wbi_img || {};
  const key = (u) => u.split("/").pop().split(".")[0];
  return { imgKey: key(img_url), subKey: key(sub_url) };
}

export function signWbi(params, { imgKey, subKey }) {
  const mixinKey = getMixinKey(imgKey, subKey);
  const withWts = { ...params, wts: Math.floor(Date.now() / 1000) };
  const sorted = Object.keys(withWts).sort();
  const parts = [];
  for (const k of sorted) {
    let v = withWts[k];
    if (v === undefined || v === null || v === "") continue;
    v = String(v).replace(/[!'(),]/g, "");
    parts.push(`${urlEncode(k)}=${urlEncode(v)}`);
  }
  const query = parts.join("&");
  const w_rid = createHash("md5")
    .update(query + mixinKey)
    .digest("hex");
  return `${query}&w_rid=${w_rid}`;
}

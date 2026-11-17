// 扫码登录：复刻 passport 的 qrcode/generate 与 qrcode/poll。
import { biliHeaders, setCookies } from "../lib/http.js";
import { mergeSetCookies } from "../lib/storage.js";

const PASSPORT = "https://passport.bilibili.com/x/passport-login/web/qrcode";

export async function generateQrcode() {
  const res = await fetch(`${PASSPORT}/generate`, { headers: biliHeaders() });
  const json = await res.json();
  if (json.code !== 0) throw new Error(`生成二维码失败: ${json.message}`);
  return { url: json.data.url, qrcodeKey: json.data.qrcode_key };
}

// code: 0 成功 / 86101 未扫码 / 86090 已扫码待确认 / 86038 二维码过期
export async function pollQrcode(qrcodeKey, jar) {
  const res = await fetch(`${PASSPORT}/poll?qrcode_key=${qrcodeKey}`, {
    headers: biliHeaders(),
  });
  const json = await res.json();
  const data = json.data || {};
  if (String(data.code) === "0") {
    mergeSetCookies(jar, setCookies(res));
    return { status: "success", message: data.message || "登录成功", jar };
  }
  return { status: String(data.code), message: data.message || "" };
}

// 流式下载：带 Referer/UA/Cookie，支持 Range 断点续传。
// 原项目用 aria2c 多线程，这里用 Node fetch 单连接流式实现，行为等价、少一个外部依赖。
import fs from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export async function download(url, dest, { headers = {}, onProgress, signal } = {}) {
  const existing = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
  const h = { ...headers };
  if (existing > 0) h.Range = `bytes=${existing}-`;

  const res = await fetch(url, { headers: h, signal });
  if (res.status === 416) {
    // 文件已下完
    if (onProgress) onProgress(existing, existing);
    return existing;
  }
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);

  const clen = Number(res.headers.get("content-length") || 0);
  let base, total, flags;
  if (res.status === 206) {
    base = existing;
    total = existing + clen;
    flags = "a";
  } else {
    base = 0;
    total = clen;
    flags = "w";
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
  }

  let downloaded = base;
  const progress = new Transform({
    transform(chunk, _enc, cb) {
      downloaded += chunk.length;
      if (onProgress) onProgress(downloaded, total);
      cb(null, chunk);
    },
  });

  const out = fs.createWriteStream(dest, { flags });
  await pipeline(Readable.fromWeb(res.body), progress, out);
  return downloaded;
}

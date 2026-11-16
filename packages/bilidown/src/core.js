// BiliDown 可编程内核：把下载链路与登录拆成带回调的函数，供 CLI 与服务端共同调用。
//   与 index.js 的关系：CLI 是终端壳（渲染二维码 / 打进度），实际逻辑都走这里，避免两份实现。
import fs from "node:fs";
import path from "node:path";

import {
  extractWbiKeys,
  getMp4Url,
  getPlayurl,
  nav,
  pickAudio,
  pickVideo,
  streamUrl,
  view,
} from "./api/bili.js";
import { generateQrcode, pollQrcode } from "./api/login.js";
import { download as downloadStream } from "./lib/download.js";
import { mux, toMp3 } from "./lib/ffmpeg.js";
import { biliHeaders } from "./lib/http.js";
import { cookieString, loadCookies, saveCookies } from "./lib/storage.js";

export const QN_ALIAS = {
  360: 16,
  480: 32,
  720: 64,
  1080: 80,
  "1080p60": 116,
  "4k": 120,
  "8k": 127,
};

export function parseBvid(input) {
  const m = String(input).match(/BV[0-9A-Za-z]{10}/);
  if (!m) throw new Error(`无法从 "${input}" 解析出 BV 号`);
  return m[0];
}

export function resolveQn(v) {
  if (v === undefined) return 127;
  const key = String(v).toLowerCase();
  return QN_ALIAS[key] !== undefined ? QN_ALIAS[key] : parseInt(v, 10);
}

export function sanitize(s) {
  return s.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
}

/** 读取已存 cookie 的登录态：未登录时仅返回标记，不请求 nav */
export async function getLoginStatus() {
  const cookieStr = cookieString(loadCookies());
  if (!cookieStr) return { isLogin: false, hasCookie: false };
  const d = (await nav(cookieStr)).data || {};
  return {
    isLogin: Boolean(d.isLogin),
    hasCookie: true,
    uname: d.uname || "(未命名)",
    vipStatus: Boolean(d.vipStatus),
  };
}

/** 生成登录二维码：返回登录页 URL（前端/终端渲染）+ 轮询 key + 本次会话初始 cookie jar */
export async function createLoginQrcode() {
  const { url, qrcodeKey } = await generateQrcode();
  return { url, qrcodeKey, jar: loadCookies() };
}

/**
 * 轮询登录状态。成功时把响应的 Set-Cookie 合并进 jar 并落盘。
 * 返回 status：success / 86101(未扫码) / 86090(已扫码待确认) / 86038(二维码过期)
 */
export async function pollLogin(qrcodeKey, jar) {
  const r = await pollQrcode(qrcodeKey, jar);
  if (r.status === "success") {
    saveCookies(jar);
    const d = (await nav(cookieString(jar))).data || {};
    return {
      status: "success",
      uname: d.uname || "(未命名)",
      vipStatus: Boolean(d.vipStatus),
    };
  }
  return { status: r.status, message: r.message };
}

/** 仅取视频信息（标题 + 分 P 列表），供前端展示可选 P */
export async function getInfo(input) {
  const bvid = parseBvid(input);
  const info = await view(bvid);
  return {
    bvid,
    title: info.title,
    pages: info.pages.map((p) => ({ page: p.page, part: p.part, duration: p.duration })),
  };
}

function makeProgressCb(opts, stream) {
  return (downloaded, total) => opts.onProgress?.({ stream, downloaded, total });
}

/**
 * 解析并下载一个视频。
 * opts: { input, p, qn, audio, noCookie, outDir|out, outName, ffmpeg, keep, signal,
 *         onStage(stage), onProgress({stream,downloaded,total}), onLog(message, level) }
 * 返回 { filePath, fileName, title, page, bvid }
 */
export async function download(opts) {
  const log = (msg, level = "log") => opts.onLog?.(msg, level);
  const stage = (s) => opts.onStage?.(s);

  const bvid = parseBvid(opts.input);
  const outDir = path.resolve(opts.outDir ?? opts.out ?? "downloads");
  fs.mkdirSync(outDir, { recursive: true });
  const tmpDir = path.join(outDir, ".tmp");
  fs.mkdirSync(tmpDir, { recursive: true });

  const cookieStr = opts.noCookie ? "" : cookieString(loadCookies());

  stage("parse");
  const info = await view(bvid);
  const pages = info.pages;
  const pageIdx = Math.max(1, opts.p || 1) - 1;
  const page = pages[pageIdx] || pages[0];
  log(`解析到：${info.title}（P${page.page} ${page.part}，aid=${info.aid}，cid=${page.cid}）`);

  const navRes = await nav(cookieStr);
  const wbiKeys = extractWbiKeys(navRes.data);
  if (cookieStr && !navRes.data.isLogin) {
    log("登录已失效（cookie 过期或无效），高清/4K/大会员将受限", "warn");
  } else if (!cookieStr) {
    log("未携带 cookie，画质可能受限", "warn");
  }

  const dlHeaders = biliHeaders(cookieStr ? { Cookie: cookieStr } : {});
  const qn = resolveQn(opts.qn);
  const audioOnly = Boolean(opts.audio);
  const ext = audioOnly ? ".mp3" : ".mp4";
  const base = opts.outName || `${sanitize(info.title)}-P${page.page}${ext}`;
  const finalPath = path.join(outDir, base);
  const vPath = path.join(tmpDir, `${base}.v.m4s`);
  const aPath = path.join(tmpDir, `${base}.a.m4s`);

  let play;
  try {
    play = await getPlayurl({ bvid, cid: page.cid, qn }, wbiKeys, cookieStr);
  } catch (e) {
    log(`DASH 取流失败(${e.message})，回退 html5 mp4`, "warn");
    play = null;
  }

  if (play && play.dash && play.dash.video && play.dash.video.length) {
    const video = pickVideo(play.dash.video, qn);
    const audio = play.dash.audio && play.dash.audio.length ? pickAudio(play.dash.audio) : null;
    log(`视频流: id=${video.id} ${video.width}x${video.height} ${video.codecs || ""}`);

    if (audioOnly && audio) {
      stage("audio");
      await downloadStream(streamUrl(audio), aPath, {
        headers: dlHeaders,
        signal: opts.signal,
        onProgress: makeProgressCb(opts, "audio"),
      });
      stage("mux");
      await toMp3(aPath, finalPath, opts.ffmpeg, opts.signal);
    } else {
      stage("video");
      await downloadStream(streamUrl(video), vPath, {
        headers: dlHeaders,
        signal: opts.signal,
        onProgress: makeProgressCb(opts, "video"),
      });
      if (audio) {
        stage("audio");
        await downloadStream(streamUrl(audio), aPath, {
          headers: dlHeaders,
          signal: opts.signal,
          onProgress: makeProgressCb(opts, "audio"),
        });
        stage("mux");
        await mux(vPath, aPath, finalPath, opts.ffmpeg, opts.signal);
      } else {
        // 无独立音频轨：视频流自带音频，直接改名即成品
        fs.renameSync(vPath, finalPath);
      }
    }
  } else if (play && play.durl) {
    stage("video");
    log(`单文件 MP4（共 ${play.durl.length} 段，取第一段）`, "warn");
    await downloadStream(play.durl[0].url, finalPath, {
      headers: dlHeaders,
      signal: opts.signal,
      onProgress: makeProgressCb(opts, "single"),
    });
  } else {
    log("无 DASH，使用 html5 老接口取 mp4", "warn");
    stage("video");
    const data = await getMp4Url({ aid: info.aid, cid: page.cid, qn: Math.min(qn, 64) }, cookieStr);
    if (!data || !data.durl) throw new Error("未能取得任何下载地址");
    await downloadStream(data.durl[0].url, finalPath, {
      headers: dlHeaders,
      signal: opts.signal,
      onProgress: makeProgressCb(opts, "single"),
    });
  }

  if (!opts.keep) {
    // 逐个清理本次中间文件，避免并发下载时误删他人在用的 .tmp
    for (const p of [vPath, aPath]) {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* 忽略 */
      }
    }
  }
  stage("done");
  return { filePath: finalPath, fileName: base, title: info.title, page: page.page, bvid };
}

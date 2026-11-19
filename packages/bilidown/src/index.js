#!/usr/bin/env node
// BiliDown CLI 终端壳：把 core.js 的回调打到 stdout。
// 实际下载链路在 src/core.js（服务端 bili 模块共用同一份逻辑）。
// 登录已改为服务端扫码入库，CLI 不再持有 cookie：下载走 --no-cookie 或环境变量 BILI_COOKIE。
import { download, getInfo, getLoginStatus } from "./core.js";

const HELP = `用法:
  bilidown info <BV号|视频链接>               只看视频信息与分 P 列表
  bilidown <BV号|视频链接> [选项]              解析并下载

选项:
  --p <n>        分 P 序号(默认 1)
  --qn <x>       清晰度: 360/480/720/1080/1080p60/4k/8k 或数字 id(默认最高)
  --audio        只下载音频并转 mp3
  --out <dir>    输出目录(默认 ./downloads)
  --ffmpeg <p>   ffmpeg 可执行文件路径(默认在 PATH 中找 ffmpeg)
  --keep         保留下载的音视频中间文件
  --no-cookie    不携带 cookie 下载(仅低画质)

环境变量:
  BILI_COOKIE    下载携带的 cookie 串(如 "SESSDATA=...; bili_jct=...")；
                 登录请用 Web 端扫码，cookie 会存到服务端数据库。

示例:
  bilidown BV1xx411c7mD --p 2 --qn 1080
  bilidown https://www.bilibili.com/video/BV1xx411c7mD --audio
`;

function fmtBytes(n) {
  if (!n) return "0B";
  const mb = n / 1048576;
  return mb >= 1 ? `${mb.toFixed(1)}MB` : `${(n / 1024).toFixed(0)}KB`;
}

async function runInfo(input) {
  const info = await getInfo(input);
  console.log(`${info.title}（${info.bvid}）`);
  for (const p of info.pages) {
    console.log(`  P${p.page}  ${p.part}  ${p.duration}s`);
  }
}

async function runDownload(input, opts) {
  const status = await getLoginStatus();
  if (status.isLogin) {
    console.log(`已登录: ${status.uname}${status.vipStatus ? " [大会员]" : ""}`);
  }

  const label = (stream) =>
    stream === "audio" ? "下载音频" : stream === "video" ? "下载视频" : "下载";
  const drawProgress = ({ stream, downloaded, total }) => {
    const pct = total ? ` / ${fmtBytes(total)} (${((downloaded / total) * 100).toFixed(1)}%)` : "";
    process.stdout.write(`\r  ${label(stream)}: ${fmtBytes(downloaded)}${pct}        `);
    if (total && downloaded >= total) process.stdout.write("\n");
  };

  const res = await download({
    input,
    p: opts.p,
    qn: opts.qn,
    audio: opts.audio,
    noCookie: opts["no-cookie"],
    out: opts.out,
    ffmpeg: opts.ffmpeg,
    keep: opts.keep,
    onLog: (msg, level) => (level === "warn" ? console.warn : console.log)(`  ${msg}`),
    onStage: (s) => {
      if (s === "mux") console.log("  混流中...");
    },
    onProgress: drawProgress,
  });
  console.log(`完成: ${res.filePath}`);
}

function parseArgs(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--p") opts.p = parseInt(argv[++i], 10);
    else if (a === "--qn") opts.qn = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--ffmpeg") opts.ffmpeg = argv[++i];
    else if (a === "--audio") opts.audio = true;
    else if (a === "--keep") opts.keep = true;
    else if (a === "--no-cookie") opts["no-cookie"] = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else rest.push(a);
  }
  return { opts, rest };
}

async function main() {
  const { opts, rest } = parseArgs(process.argv.slice(2));
  if (opts.help || rest.length === 0) {
    console.log(HELP);
    return;
  }
  if (rest[0] === "login") {
    console.error(
      "登录已改为 Web 端扫码（cookie 存服务端数据库）。CLI 下载请用 --no-cookie 或设置 BILI_COOKIE。",
    );
    process.exit(1);
  }
  if (rest[0] === "info") return runInfo(rest[1]);
  return runDownload(rest[0], opts);
}

main().catch((e) => {
  console.error("\n出错:", e.message);
  process.exit(1);
});

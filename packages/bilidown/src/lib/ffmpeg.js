// ffmpeg 混流：复刻渲染层对 ffmpeg.exe 的调用。
//   混流:   ffmpeg -y -i video -i audio -acodec copy -vcodec copy -f mp4 out
//   转音频:  ffmpeg -y -i input -q:a 0 -map a out.mp3
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import ffmpegStatic from "ffmpeg-static";

// 默认优先使用随包附带的 ffmpeg-static，缺失时退回 PATH 中的 ffmpeg。
const DEFAULT_BIN = ffmpegStatic && existsSync(ffmpegStatic) ? ffmpegStatic : "ffmpeg";

function run(bin, args, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("已取消"));
      return;
    }
    const p = spawn(bin, args, { windowsHide: true });
    let err = "";
    const onAbort = () => {
      if (!p.killed) p.kill("SIGKILL");
      reject(new Error("已取消"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", (e) => {
      signal?.removeEventListener("abort", onAbort);
      reject(
        new Error(`无法启动 ffmpeg("${bin}")，请安装 ffmpeg 或用 --ffmpeg 指定路径。${e.message}`),
      );
    });
    p.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}\n${err}`));
    });
  });
}

export function mux(videoPath, audioPath, outPath, bin = DEFAULT_BIN, signal) {
  return run(
    bin,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      videoPath,
      "-i",
      audioPath,
      "-c",
      "copy",
      "-f",
      "mp4",
      outPath,
    ],
    signal,
  );
}

export function toMp3(inputPath, outPath, bin = DEFAULT_BIN, signal) {
  return run(
    bin,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputPath,
      "-q:a",
      "0",
      "-map",
      "a",
      outPath,
    ],
    signal,
  );
}

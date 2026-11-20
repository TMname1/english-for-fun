import { execFile } from "node:child_process";
import { promisify } from "node:util";

import ffmpegStatic from "ffmpeg-static";

const execFileAsync = promisify(execFile);

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

let ffmpegPath: string | null = null;

export async function getFfmpegPath(): Promise<string> {
  if (ffmpegPath) {
    return ffmpegPath;
  }
  if (!ffmpegStatic) {
    throw new Error(
      "ffmpeg-static 未提供可执行文件（通常在 pnpm install 的 postinstall 阶段下载）。请重新安装依赖：pnpm install",
    );
  }
  ffmpegPath = ffmpegStatic;
  return ffmpegPath;
}

/** 运行 ffmpeg，失败时抛出含 stderr 摘要的错误 */
export async function runFfmpeg(args: string[]): Promise<void> {
  const bin = await getFfmpegPath();
  try {
    await execFileAsync(bin, ["-hide_banner", "-loglevel", "error", ...args], {
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = (error as { stderr?: string })?.stderr ?? "";
    throw new Error(`ffmpeg 执行失败: ffmpeg ${args.join(" ")}\n${stderr.slice(0, 500)}`);
  }
}

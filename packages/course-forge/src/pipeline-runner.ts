/**
 * Course Forge GUI 流水线运行入口（被 apps/api 用 tsx 拉起）。
 *
 * 不是 CLI：直接 import forgeMake 函数调用，参数从 process.env 读取，避免 argv 转义 / 路径空格。
 *
 * 协议：
 *   stdout 仅写 JSON Lines（每行一个事件），父进程按 \n 切片解析
 *     { event: "stage", stage: "transcoding" | "transcribing" | "structuring" | "aligning" | "done" }
 *     { event: "done",  outDir: "<绝对路径>" }
 *     { event: "error", message: "<错误>" }
 *   forgeMake 内部的 console.log/warn/error 一律劫持到 stderr，避免污染事件流。
 *
 * 环境变量：
 *   FORGE_MEDIA_PATH  视频/音频绝对路径（必填）
 *   FORGE_TITLE       课程包标题（必填）
 *   FORGE_TYPE        dialogue | music（必填）
 *   FORGE_DESC        描述（可选）
 *   FORGE_LANGUAGE    ASR 语言提示（可选，默认 en）
 *   FORGE_OUT_DIR     产物目录绝对路径（必填，由调用方分配，避免与 CLI 模式 runId 冲突）
 */

import { forgeMake } from "./forge";

console.log = (...args: unknown[]) => {
  process.stderr.write(args.map(String).join(" ") + "\n");
};
console.warn = console.log;
console.error = console.log;
console.info = console.log;
console.debug = console.log;

function emit(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`缺少环境变量 ${key}`);
  }
  return value;
}

async function main(): Promise<void> {
  const type = requireEnv("FORGE_TYPE");
  if (type !== "dialogue" && type !== "music") {
    throw new Error(`FORGE_TYPE 必须是 dialogue 或 music，收到 ${type}`);
  }

  try {
    const outDir = await forgeMake({
      mediaPath: requireEnv("FORGE_MEDIA_PATH"),
      title: requireEnv("FORGE_TITLE"),
      type,
      description: process.env.FORGE_DESC?.trim() || undefined,
      language: process.env.FORGE_LANGUAGE?.trim() || "en",
      outDir: requireEnv("FORGE_OUT_DIR"),
      onStage: (stage) => emit({ event: "stage", stage }),
    });
    emit({ event: "done", outDir });
    process.exit(0);
  } catch (error) {
    emit({ event: "error", message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
}

main();

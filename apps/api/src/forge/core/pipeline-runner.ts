/**
 * Course Forge GUI 流水线运行入口（被 apps/api 用 tsx 拉起）。
 *
 * 不是 CLI：直接 import forgeMake 函数调用，参数从 process.env 读取，避免 argv 转义 / 路径空格。
 *
 * 协议：
 *   stdout 仅写 JSON Lines（每行一个事件），父进程按 \n 切片解析
 *     { event: "stage", stage: "transcoding" | "transcribing" | "structuring" | "aligning" | "done" }
 *     { event: "done",  outDir: "<绝对路径>" }
 *     { event: "needs_fix", outDir: "<绝对路径>" }
 *     { event: "error", message: "<错误>" }
 *   forgeMake 内部的 console.log/warn/error 一律劫持到 stderr，避免污染事件流。
 *
 * 环境变量：
 *   FORGE_PHASE       transcribe | structure | structure-resolve（必填）：
 *                     transcribe 跑「提取音轨 + ASR 转写」后暂停；
 *                     structure 读 outDir 下（人工编辑过的）transcript.json 续跑「结构化 + 对齐」；
 *                     structure-resolve 读进度快照与 resolve 决策，只重跑 retry 句后合并收尾
 *   FORGE_MEDIA_PATH  视频/音频绝对路径（transcribe 阶段必填）
 *   FORGE_TITLE       课程包标题（transcribe 阶段必填）
 *   FORGE_TYPE        dialogue | music（transcribe 阶段必填）
 *   FORGE_DESC        描述（可选）
 *   FORGE_LANGUAGE    ASR 语言提示（可选，默认 en）
 *   FORGE_OUT_DIR     产物目录绝对路径（必填，由调用方分配，避免与 CLI 模式 runId 冲突）
 *   FORGE_CLIPS       选中时间区间 JSON（可选，[{start,end}]，秒）；缺省转写整段
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ClipRange } from "./types";
import { forgeStructureInteractive, forgeStructureResolve, forgeTranscribe } from "./forge";
import { normalizeEditedTranscript } from "./transcript-edit";

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
  const phaseRaw = process.env.FORGE_PHASE ?? "transcribe";
  const phase =
    phaseRaw === "structure" || phaseRaw === "structure-resolve" ? phaseRaw : "transcribe";
  const outDir = requireEnv("FORGE_OUT_DIR");

  try {
    if (phase === "structure") {
      // 读取前端回传的 word 级编辑结果，规整回 Transcript（重算 text/wordLevel、移除被删段），
      // 覆盖 transcript.json 后续跑结构化 + 对齐。
      const editsRaw = JSON.parse(
        await readFile(resolve(outDir, "transcript.edited.json"), "utf-8"),
      );
      const transcript = normalizeEditedTranscript(
        editsRaw,
        process.env.FORGE_LANGUAGE?.trim() || "en",
      );
      await writeFile(
        resolve(outDir, "transcript.json"),
        `${JSON.stringify(transcript, null, 2)}\n`,
        "utf-8",
      );
      const result = await forgeStructureInteractive({
        outDir,
        onStage: (stage) => emit({ event: "stage", stage }),
      });
      emit(result.needsFix ? { event: "needs_fix", outDir } : { event: "done", outDir });
    } else if (phase === "structure-resolve") {
      const result = await forgeStructureResolve({
        outDir,
        onStage: (stage) => emit({ event: "stage", stage }),
      });
      emit(result.needsFix ? { event: "needs_fix", outDir } : { event: "done", outDir });
    } else {
      const type = requireEnv("FORGE_TYPE");
      if (type !== "dialogue" && type !== "music") {
        throw new Error(`FORGE_TYPE 必须是 dialogue 或 music，收到 ${type}`);
      }
      let clips: ClipRange[] | undefined;
      if (process.env.FORGE_CLIPS?.trim()) {
        const parsed = JSON.parse(process.env.FORGE_CLIPS) as ClipRange[];
        if (
          !Array.isArray(parsed) ||
          parsed.some((c) => !Number.isFinite(c?.start) || !Number.isFinite(c?.end))
        ) {
          throw new Error("FORGE_CLIPS 必须是 [{start,end}] 形式的 JSON 数组");
        }
        clips = parsed;
      }
      const finalDir = await forgeTranscribe({
        mediaPath: requireEnv("FORGE_MEDIA_PATH"),
        title: requireEnv("FORGE_TITLE"),
        type,
        description: process.env.FORGE_DESC?.trim() || undefined,
        language: process.env.FORGE_LANGUAGE?.trim() || "en",
        outDir,
        clips,
        onStage: (stage) => emit({ event: "stage", stage }),
      });
      emit({ event: "done", outDir: finalDir });
    }
    process.exit(0);
  } catch (error) {
    emit({ event: "error", message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
}

main();

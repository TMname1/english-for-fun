import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ForgeMeta, ForgePayload } from "./types";
import { ensureAsrReady, stopAsrService, transcodeToWav, transcribe } from "./asr";
import { config, createRunId } from "./config";
import { generateDraft } from "./llm";
import { preflightLlm } from "./preflight";

export interface MakeOptions {
  audioPath: string;
  title: string;
  description?: string;
  type: "dialogue" | "music";
  language?: string;
  outDir?: string;
}

export const paths = {
  meta: (outDir: string) => resolve(outDir, "meta.json"),
  transcript: (outDir: string) => resolve(outDir, "transcript.json"),
  course: (outDir: string) => resolve(outDir, "course.json"),
  work: (outDir: string) => resolve(outDir, ".work"),
};

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

export async function forgeMake(opts: MakeOptions): Promise<string> {
  const audioPath = resolve(opts.audioPath);
  if (!existsSync(audioPath)) {
    throw new Error(`[forge] 音频文件不存在: ${audioPath}`);
  }

  const runId = createRunId();
  const outDir = resolve(opts.outDir ?? resolve(config.defaultOutRoot, runId));
  await mkdir(outDir, { recursive: true });

  const meta: ForgeMeta = {
    runId,
    title: opts.title,
    description: opts.description ?? `由本地 Course Forge 流水线生成（${opts.type}）`,
    type: opts.type,
    audioPath,
    createdAt: new Date().toISOString(),
  };
  await writeJson(paths.meta(outDir), meta);

  // Step 1 转写
  await ensureAsrReady();
  const wav = resolve(paths.work(outDir), "audio-16k.wav");
  await mkdir(paths.work(outDir), { recursive: true });
  await transcodeToWav(audioPath, wav);
  const transcript = await transcribe(wav, opts.language ?? "en");
  await writeJson(paths.transcript(outDir), transcript);
  await rm(paths.work(outDir), { recursive: true, force: true });
  console.log(
    `[forge] 转写完成：${transcript.segments.length} 段（词级时间戳：${transcript.wordLevel ? "有" : "无，段级降级"}）`,
  );

  // Step 1.5：转写一结束就停 asr 容器——whisper 空闲时也占着显存，小显存卡上会挤爆 LLM 加载
  if (config.asrStopAfterTranscribe) {
    stopAsrService();
  }

  // Step 2 LLM 结构化
  if (config.llmPreflight) {
    await preflightLlm();
  }
  const draft = await generateDraft(transcript, opts.type, opts.title);
  console.log(
    `[forge] 结构化完成：1 课（单一课程，长音频分块已合并）/ ${draft.statements.length} 条 statement`,
  );

  // Step 3 产物：直接由内存中的 draft + meta 合成 course.json（不再落 draft.json，不产出 audioUrl）
  const payload: ForgePayload = {
    title: meta.title,
    description: meta.description,
    cover: "",
    courses: {
      title: draft.title,
      description: draft.description ?? "",
      statements: draft.statements,
    },
  };
  await writeJson(paths.course(outDir), payload);
  console.log(`[forge] 产物目录：${outDir}`);
  console.log(`[forge] 下一步：校对 course.json，然后运行 pnpm forge:import -- --out "${outDir}"`);
  return outDir;
}

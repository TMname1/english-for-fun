import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ForgeMeta, ForgePayload, Transcript } from "./types";
import { alignStatements, formatAlignmentSummary } from "./align";
import { ensureAsrReady, stopAsrService, transcodeToWav, transcribe } from "./asr";
import { config, createRunId } from "./config";
import { generateDraft } from "./llm";
import { preflightLlm } from "./preflight";

/** transcribed 表示「已转录、等待人工校对」，仅 GUI 两段式流程使用 */
export type ForgeStage =
  | "transcoding"
  | "transcribing"
  | "transcribed"
  | "structuring"
  | "aligning"
  | "done";

export interface MakeOptions {
  /** 视频或音频文件路径；视频会用 ffmpeg 提取音频转写，并保留视频做时间戳同步 */
  mediaPath: string;
  title: string;
  description?: string;
  type: "dialogue" | "music";
  language?: string;
  outDir?: string;
  /** 阶段回调；GUI 调用方据此渲染进度，CLI 调用方忽略 */
  onStage?: (stage: ForgeStage) => void;
}

/** 第二段（结构化 + 对齐）入参：从磁盘读取已（人工编辑过的）transcript.json 与 meta.json */
export interface FromTranscriptOptions {
  outDir: string;
  onStage?: (stage: ForgeStage) => void;
}

const VIDEO_EXT = /\.(mp4|m4v|mkv|webm|mov|avi)$/i;

export const paths = {
  meta: (outDir: string) => resolve(outDir, "meta.json"),
  transcript: (outDir: string) => resolve(outDir, "transcript.json"),
  transcriptRaw: (outDir: string) => resolve(outDir, "transcript.raw.json"),
  course: (outDir: string) => resolve(outDir, "course.json"),
  alignment: (outDir: string) => resolve(outDir, "alignment.json"),
  work: (outDir: string) => resolve(outDir, ".work"),
};

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf-8")) as T;
}

/**
 * 第一段：提取音轨 + ASR 转写，写出 transcript.json（同时保留一份 transcript.raw.json 供回溯），
 * 随后停掉 asr 容器把显存让给 LLM。GUI 流程在此暂停等待人工校对。
 */
export async function forgeTranscribe(opts: MakeOptions): Promise<string> {
  const mediaPath = resolve(opts.mediaPath);
  if (!existsSync(mediaPath)) {
    throw new Error(`[forge] 媒体文件不存在: ${mediaPath}`);
  }
  const isVideo = VIDEO_EXT.test(mediaPath);

  const runId = createRunId();
  const outDir = resolve(opts.outDir ?? resolve(config.defaultOutRoot, runId));
  await mkdir(outDir, { recursive: true });

  const meta: ForgeMeta = {
    runId,
    title: opts.title,
    description: opts.description ?? `由本地 Course Forge 流水线生成（${opts.type}）`,
    type: opts.type,
    audioPath: mediaPath,
    ...(isVideo ? { videoPath: mediaPath } : {}),
    createdAt: new Date().toISOString(),
  };
  await writeJson(paths.meta(outDir), meta);

  // 视频输入时 ffmpeg -vn 直接提取音轨；时间戳相对同一时间轴，天然与视频同步
  opts.onStage?.("transcoding");
  await ensureAsrReady();
  const wav = resolve(paths.work(outDir), "audio-16k.wav");
  await mkdir(paths.work(outDir), { recursive: true });
  await transcodeToWav(mediaPath, wav);
  opts.onStage?.("transcribing");
  const transcript = await transcribe(wav, opts.language ?? "en");
  await writeJson(paths.transcript(outDir), transcript);
  await writeJson(paths.transcriptRaw(outDir), transcript);
  await rm(paths.work(outDir), { recursive: true, force: true });
  console.log(
    `[forge] 转写完成：${transcript.segments.length} 段（词级时间戳：${transcript.wordLevel ? "有" : "无，段级降级"}）`,
  );

  // 转写一结束就停 asr 容器——whisper 空闲时也占着显存，小显存卡上会挤爆 LLM 加载
  if (config.asrStopAfterTranscribe) {
    stopAsrService();
  }

  return outDir;
}

/**
 * 第二段：读取（人工编辑过的）transcript.json 与 meta.json，做 LLM 结构化 + 时间戳对齐，
 * 合成 course.json。word 级编辑只改词文字、保留每词 start/end 与词数，故对齐时间天然稳定。
 */
export async function forgeFromTranscript(opts: FromTranscriptOptions): Promise<string> {
  const outDir = resolve(opts.outDir);
  const meta = await readJson<ForgeMeta>(paths.meta(outDir));
  const transcript = await readJson<Transcript>(paths.transcript(outDir));
  const isVideo = Boolean(meta.videoPath);

  opts.onStage?.("structuring");
  if (config.llmPreflight) {
    await preflightLlm();
  }
  const draft = await generateDraft(transcript, meta.type, meta.title);
  console.log(
    `[forge] 结构化完成：1 课（单一课程，长音频分块已合并）/ ${draft.statements.length} 条 statement`,
  );

  // 时间戳对齐：把转写的词级时间映射回每条 statement（视频同步播放的数据来源）
  opts.onStage?.("aligning");
  const { timings, report } = alignStatements(transcript, draft.statements);
  draft.statements.forEach((statement, i) => {
    const timing = timings[i];
    if (timing) {
      statement.startTime = timing.startTime;
      statement.endTime = timing.endTime;
      statement.words = timing.words;
    }
  });
  await writeJson(paths.alignment(outDir), report);
  console.log(`[forge] ${formatAlignmentSummary(report)}`);
  if (report.rate < 0.85) {
    console.warn(
      `[forge] 警告：对齐成功率低于 85%，请对照 alignment.json 人工校对 course.json 的时间戳`,
    );
  }
  if (!isVideo) {
    console.log(`[forge] 提示：输入不是视频文件，时间戳仅供音频同步，导入后前端仍走 TTS/音频回退`);
  }

  // Step 3 产物：直接由内存中的 draft + meta 合成 course.json（不再落 draft.json，不产出音频切片）
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
  opts.onStage?.("done");
  console.log(`[forge] 产物目录：${outDir}`);
  return outDir;
}

/** CLI 一次性跑完整条流水线（串联两段），保留以兼容 `pnpm forge` */
export async function forgeMake(opts: MakeOptions): Promise<string> {
  const outDir = await forgeTranscribe(opts);
  await forgeFromTranscript({ outDir, onStage: opts.onStage });
  console.log(`[forge] 下一步：校对 course.json，然后运行 pnpm forge:import -- --out "${outDir}"`);
  return outDir;
}

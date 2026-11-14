import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ForgeMeta, ForgePayload } from "./types";
import { alignStatements, formatAlignmentSummary } from "./align";
import { ensureAsrReady, stopAsrService, transcodeToWav, transcribe } from "./asr";
import { config, createRunId } from "./config";
import { generateDraft } from "./llm";
import { preflightLlm } from "./preflight";

export interface MakeOptions {
  /** 视频或音频文件路径；视频会用 ffmpeg 提取音频转写，并保留视频做时间戳同步 */
  mediaPath: string;
  title: string;
  description?: string;
  type: "dialogue" | "music";
  language?: string;
  outDir?: string;
}

const VIDEO_EXT = /\.(mp4|m4v|mkv|webm|mov|avi)$/i;

export const paths = {
  meta: (outDir: string) => resolve(outDir, "meta.json"),
  transcript: (outDir: string) => resolve(outDir, "transcript.json"),
  course: (outDir: string) => resolve(outDir, "course.json"),
  alignment: (outDir: string) => resolve(outDir, "alignment.json"),
  work: (outDir: string) => resolve(outDir, ".work"),
};

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

export async function forgeMake(opts: MakeOptions): Promise<string> {
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

  // Step 1 转写（视频输入时 ffmpeg -vn 直接提取音轨；时间戳相对同一时间轴，天然与视频同步）
  await ensureAsrReady();
  const wav = resolve(paths.work(outDir), "audio-16k.wav");
  await mkdir(paths.work(outDir), { recursive: true });
  await transcodeToWav(mediaPath, wav);
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

  // Step 2.5 时间戳对齐：把转写的词级时间映射回每条 statement（视频同步播放的数据来源）
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

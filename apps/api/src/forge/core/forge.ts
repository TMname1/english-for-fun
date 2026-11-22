import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  ClipRange,
  DraftStatement,
  ForgeMeta,
  ForgePayload,
  ResolveDecision,
  SentenceFailure,
  StructureProgress,
  Transcript,
} from "./types";
import { alignStatements, formatAlignmentSummary } from "./align";
import { transcodeToWav, transcribeWithRaw } from "./asr";
import { mergeClipTranscripts, normalizeClips, offsetTranscript, tagClipBoundaries } from "./clips";
import { config, createRunId } from "./config";
import { generateDraft, generateDraftCollected } from "./llm";
import { preflightLlm } from "./preflight";
import { preprocessTranscript } from "./preprocess";

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
  /** 选中的时间区间（秒，相对原媒体绝对时间）；缺省转写整段 */
  clips?: ClipRange[];
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
  // clips 独立落盘：structure 阶段 normalizeEditedTranscript 会覆盖 transcript.json，meta 会丢
  clips: (outDir: string) => resolve(outDir, "clips.json"),
  course: (outDir: string) => resolve(outDir, "course.json"),
  alignment: (outDir: string) => resolve(outDir, "alignment.json"),
  work: (outDir: string) => resolve(outDir, ".work"),
  // 结构化进度快照（成功链 + 失败清单），needs_fix 后 resolve 续跑用
  progress: (outDir: string) => resolve(outDir, "structure.progress.json"),
  // resolve 阶段的人工决策输入（delete/retry），由 service 写入 scratch
  resolve: (outDir: string) => resolve(outDir, "structure.resolve.json"),
};

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf-8")) as T;
}

/**
 * 第一段：提取音轨 + ASR 转写 + 预处理（LLM 拆句、代码合并碎片词），
 * 写出 transcript.json（预处理后）与 transcript.raw.json（原始 ASR，供回溯）。
 * GUI 流程在此暂停等待人工校对。
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
  await mkdir(paths.work(outDir), { recursive: true });
  const language = opts.language ?? "en";
  const clips = opts.clips ? normalizeClips(opts.clips) : undefined;
  if (opts.clips && (!clips || clips.length === 0)) {
    throw new Error("[forge] clips 参数经规整后为空，请检查区间是否过短或越界");
  }

  let transcript: Transcript;
  let rawTranscript: Transcript;
  if (clips) {
    opts.onStage?.("transcribing");
    const parts: Transcript[] = [];
    const rawParts: Transcript[] = [];
    for (const [i, clip] of clips.entries()) {
      console.log(
        `[forge] 转写 clip ${i + 1}/${clips.length}（${clip.start.toFixed(2)}s–${clip.end.toFixed(2)}s）`,
      );
      const wav = resolve(paths.work(outDir), `clip-${i}.wav`);
      await transcodeToWav(mediaPath, wav, clip);
      try {
        const { transcript: rawPart, sentences } = await transcribeWithRaw(wav, language);
        rawParts.push(offsetTranscript(rawPart, clip.start));
        // 预处理在 clip 本地时间轴上进行，天然不跨 clip 拼句
        const part = await preprocessTranscript(rawPart, sentences);
        parts.push(offsetTranscript(part, clip.start));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("转写结果为空")) {
          console.warn(`[forge] clip ${i + 1} 未识别到语音（静音/纯音乐？），已跳过`);
          continue;
        }
        throw error;
      }
    }
    if (parts.length === 0) {
      throw new Error("[forge] 所有选中 clip 的转写结果均为空，未识别到英文语音");
    }
    transcript = mergeClipTranscripts(parts);
    rawTranscript = mergeClipTranscripts(rawParts);
    await writeJson(paths.clips(outDir), clips);
  } else {
    const wav = resolve(paths.work(outDir), "audio-16k.wav");
    await transcodeToWav(mediaPath, wav);
    opts.onStage?.("transcribing");
    const { transcript: raw, sentences } = await transcribeWithRaw(wav, language);
    rawTranscript = raw;
    transcript = await preprocessTranscript(raw, sentences);
  }
  await writeJson(paths.transcript(outDir), transcript);
  await writeJson(paths.transcriptRaw(outDir), rawTranscript);
  await rm(paths.work(outDir), { recursive: true, force: true });
  console.log(
    `[forge] 转写 + 预处理完成：${transcript.segments.length} 个完整句（词级时间戳：${transcript.wordLevel ? "有" : "无，段级降级"}）`,
  );

  return outDir;
}

/** 读取结构化阶段输入：meta +（人工编辑过的）transcript，并按 clips.json 重打 clipIndex */
async function loadStructureInput(
  outDir: string,
): Promise<{ meta: ForgeMeta; transcript: Transcript }> {
  const meta = await readJson<ForgeMeta>(paths.meta(outDir));
  const transcript = await readJson<Transcript>(paths.transcript(outDir));
  if (existsSync(paths.clips(outDir))) {
    const clips = await readJson<ClipRange[]>(paths.clips(outDir));
    transcript.segments = tagClipBoundaries(transcript.segments, clips);
  }
  return { meta, transcript };
}

/** 时间戳对齐 + 合成 course.json + 写 alignment.json（结构化成功后的公共收尾） */
async function finalizeCourse(
  outDir: string,
  transcript: Transcript,
  meta: ForgeMeta,
  statements: DraftStatement[],
): Promise<void> {
  const isVideo = Boolean(meta.videoPath);
  const { timings, report } = alignStatements(transcript, statements);
  statements.forEach((statement, i) => {
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

  const payload: ForgePayload = {
    title: meta.title,
    description: meta.description,
    cover: "",
    courses: {
      title: meta.title,
      description: "",
      statements,
    },
  };
  await writeJson(paths.course(outDir), payload);
}

/**
 * 第二段（严格/CLI 路径）：读取（人工编辑过的）transcript.json 与 meta.json，
 * 做 LLM 结构化 + 时间戳对齐，合成 course.json。任一句失败即整体抛错。
 */
export async function forgeFromTranscript(opts: FromTranscriptOptions): Promise<string> {
  const outDir = resolve(opts.outDir);
  const { meta, transcript } = await loadStructureInput(outDir);

  opts.onStage?.("structuring");
  if (config.llmPreflight) {
    await preflightLlm();
  }
  const draft = await generateDraft(transcript, meta.title);
  console.log(
    `[forge] 结构化完成：1 课（单一课程，逐句并发生成的组装链已按句序合并）/ ${draft.statements.length} 条 statement`,
  );

  opts.onStage?.("aligning");
  await finalizeCourse(outDir, transcript, meta, draft.statements);
  opts.onStage?.("done");
  console.log(`[forge] 产物目录：${outDir}`);
  return outDir;
}

/** 线上 GUI 结构化：内容校验失败收集为 needs_fix，而不是整体抛错 */
export async function forgeStructureInteractive(
  opts: FromTranscriptOptions,
): Promise<{ needsFix: boolean }> {
  const outDir = resolve(opts.outDir);
  const { meta, transcript } = await loadStructureInput(outDir);

  opts.onStage?.("structuring");
  if (config.llmPreflight) {
    await preflightLlm();
  }
  const { chains, failures } = await generateDraftCollected(transcript);
  if (failures.length > 0) {
    const progress: StructureProgress = {
      success: chains.map((c) => ({ index: c.index, statements: c.statements })),
      failures,
    };
    await writeJson(paths.progress(outDir), progress);
    console.log(`[forge] 结构化有 ${failures.length} 句未通过校验，已落盘进度等待人工处理`);
    return { needsFix: true };
  }

  const statements = chains.flatMap((c) => c.statements);
  console.log(
    `[forge] 结构化完成：1 课（单一课程，逐句并发生成的组装链已按句序合并）/ ${statements.length} 条 statement`,
  );
  opts.onStage?.("aligning");
  await finalizeCourse(outDir, transcript, meta, statements);
  opts.onStage?.("done");
  return { needsFix: false };
}

function validateResolveDecisions(decisions: ResolveDecision[], progress: StructureProgress): void {
  const failureIndexes = new Set(progress.failures.map((f) => f.index));
  const seen = new Set<number>();
  for (const d of decisions) {
    if (!Number.isInteger(d.index) || !failureIndexes.has(d.index)) {
      throw new Error(`[forge] 无效决策：句 ${d.index} 不在失败清单中`);
    }
    if (d.action !== "delete" && d.action !== "retry") {
      throw new Error(`[forge] 无效决策动作：${String(d.action)}`);
    }
    if (seen.has(d.index)) {
      throw new Error(`[forge] 重复决策：句 ${d.index}`);
    }
    seen.add(d.index);
  }
  const missing = [...failureIndexes].filter((i) => !seen.has(i));
  if (missing.length > 0) {
    throw new Error(`[forge] 缺少对失败句的决策：${missing.map((i) => i + 1).join(", ")}`);
  }
}

/** resolve 续跑：只重跑 retry 句，删除 delete 句，与已成功句合并后收尾 */
export async function forgeStructureResolve(
  opts: FromTranscriptOptions,
): Promise<{ needsFix: boolean }> {
  const outDir = resolve(opts.outDir);
  const { meta, transcript } = await loadStructureInput(outDir);
  const progress = await readJson<StructureProgress>(paths.progress(outDir));
  const resolveRaw = await readJson<{ decisions?: ResolveDecision[] }>(paths.resolve(outDir));
  const decisions = resolveRaw?.decisions ?? [];
  validateResolveDecisions(decisions, progress);

  const deleteSet = new Set(decisions.filter((d) => d.action === "delete").map((d) => d.index));
  const retrySet = new Set(decisions.filter((d) => d.action === "retry").map((d) => d.index));

  opts.onStage?.("structuring");
  if (config.llmPreflight) {
    await preflightLlm();
  }

  const retryIndexes = [...retrySet].sort((a, b) => a - b);
  let newChains: Array<{ index: number; statements: DraftStatement[] }> = [];
  let newFailures: SentenceFailure[] = [];
  if (retryIndexes.length > 0) {
    const result = await generateDraftCollected(transcript, retryIndexes);
    newChains = result.chains;
    newFailures = result.failures;
  }

  const kept = progress.success.filter((s) => !deleteSet.has(s.index) && !retrySet.has(s.index));
  const merged = [...kept, ...newChains].sort((a, b) => a.index - b.index);

  if (newFailures.length > 0) {
    const next: StructureProgress = { success: merged, failures: newFailures };
    await writeJson(paths.progress(outDir), next);
    console.log(`[forge] 重试后仍有 ${newFailures.length} 句未通过校验，已更新进度等待人工处理`);
    return { needsFix: true };
  }

  const statements = merged.flatMap((c) => c.statements);
  if (statements.length === 0) {
    throw new Error("[forge] 处理后没有任何句子，无法生成课程");
  }
  opts.onStage?.("aligning");
  await finalizeCourse(outDir, transcript, meta, statements);
  opts.onStage?.("done");
  return { needsFix: false };
}

/** CLI 一次性跑完整条流水线（串联两段），保留以兼容 `pnpm forge` */
export async function forgeMake(opts: MakeOptions): Promise<string> {
  const outDir = await forgeTranscribe(opts);
  await forgeFromTranscript({ outDir, onStage: opts.onStage });
  console.log(`[forge] 下一步：校对 course.json，然后运行 pnpm forge:import -- --out "${outDir}"`);
  return outDir;
}

import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import type {
  ClipRange,
  DraftChain,
  ForgeMeta,
  ForgePayload,
  ForgeStage,
  ResolveDecision,
  SentenceFailure,
  StructureProgress,
  Transcript,
} from "./types";
import { MEDIA_EXT, MEDIA_EXT_LABELS, mediaKindOf } from "../../common/media-ext";
import { alignStatements, formatAlignmentSummary } from "./align";
import { transcodeToWav, transcribeWithRaw } from "./asr";
import { mergeClipTranscripts, normalizeClips, offsetTranscript, tagClipBoundaries } from "./clips";
import { config, createRunId } from "./config";
import { generateDraft, generateDraftCollected } from "./llm";
import { preflightLlm } from "./preflight";
import { preprocessTranscript } from "./preprocess";

/** transcribed 表示「已转录、等待人工校对」，仅 GUI 两段式流程使用（已停用） */
export type { ForgeStage } from "./types";

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

/** 媒体白名单与类型判定统一走 common/media-ext（与上传入口同一份，避免第三份清单漂移） */

/**
 * 校验媒体路径：存在、是文件、非空、扩展名在白名单内。
 *
 * 目的不是拦合法输入，而是把「ffmpeg 报 Invalid data found」这种要到几十秒后才出现、
 * 且看不出该改什么的错误，提前变成一句能直接照做的提示 —— 最常见的误传是把 .md/.txt/
 * 提示词文件当成媒体路径填进 `params.mediaPath`。
 */
export function assertMediaFile(mediaPath: string): void {
  const label = `[forge] ${mediaPath}`;

  if (!existsSync(mediaPath)) {
    throw new Error(
      `${label}\n  └ 文件不存在。请检查 params.mediaPath 是否为绝对路径（Windows 反斜杠要转义或改用正斜杠）`,
    );
  }

  const stat = statSync(mediaPath);
  if (stat.isDirectory()) {
    throw new Error(`${label}\n  └ 这是一个目录，不是媒体文件。请指到目录里的具体文件`);
  }
  if (stat.size === 0) {
    throw new Error(
      `${label}\n  └ 文件是空的（0 字节），无法转写。可能是下载/导出未完成或占位文件`,
    );
  }

  const ext = extname(mediaPath).toLowerCase();
  if (!MEDIA_EXT.has(ext)) {
    const detected = ext ? `扩展名 ${ext}` : "没有扩展名";
    throw new Error(
      `${label}\n` +
        `  ├ 不是音视频文件（${detected}），ffmpeg 无法解析\n` +
        `  └ 支持的类型：${MEDIA_EXT_LABELS}`,
    );
  }
}

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
  // LangGraph 的文件 checkpointer：控制流状态（仅 graph 编排使用，legacy 不产出）
  checkpoint: (outDir: string) => resolve(outDir, "graph.checkpoint.json"),
};

export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf-8")) as T;
}

/**
 * 第一段的前半：校验媒体 + 写 meta.json + 建 .work + 规整 clips。
 * legacy（forgeTranscribe）与 graph 编排共用，保证两条路径落盘一致。
 */
export async function prepareRun(
  opts: MakeOptions,
): Promise<{ outDir: string; meta: ForgeMeta; clips?: ClipRange[] }> {
  const mediaPath = resolve(opts.mediaPath);
  assertMediaFile(mediaPath);
  const isVideo = mediaKindOf(mediaPath) === "video";

  const runId = createRunId();
  // 用 `||` 而不是 `??`：state/dev 入口传空串时要回落到默认目录，否则 resolve("") 会写到 cwd
  const outDir = resolve(opts.outDir || resolve(config.defaultOutRoot, runId));
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

  await mkdir(paths.work(outDir), { recursive: true });
  const clips = opts.clips ? normalizeClips(opts.clips) : undefined;
  if (opts.clips && (!clips || clips.length === 0)) {
    throw new Error("[forge] clips 参数经规整后为空，请检查区间是否过短或越界");
  }
  return { outDir, meta, clips };
}

/**
 * 第一段的后半：提取音轨 → ASR → 预处理 → 写 transcript.json / transcript.raw.json / clips.json。
 * 视频输入时 ffmpeg -vn 直接提取音轨，时间戳相对同一时间轴，天然与视频同步。
 */
export async function transcribeRun(args: {
  outDir: string;
  mediaPath: string;
  clips?: ClipRange[];
  language?: string;
  onStage?: (stage: ForgeStage) => void;
}): Promise<{ transcript: Transcript; rawTranscript: Transcript }> {
  const { outDir } = args;
  const mediaPath = resolve(args.mediaPath);
  const language = args.language ?? "en";
  const { clips } = args;

  args.onStage?.("transcoding");

  let transcript: Transcript;
  let rawTranscript: Transcript;
  if (clips) {
    args.onStage?.("transcribing");
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
    args.onStage?.("transcribing");
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

  return { transcript, rawTranscript };
}

/**
 * 第一段：提取音轨 + ASR 转写 + 预处理（LLM 拆句、代码合并碎片词），
 * 写出 transcript.json（预处理后）与 transcript.raw.json（原始 ASR，供回溯）。
 * GUI 流程在此暂停等待人工校对。
 */
export async function forgeTranscribe(opts: MakeOptions): Promise<string> {
  const { outDir, clips } = await prepareRun(opts);
  await transcribeRun({
    outDir,
    mediaPath: opts.mediaPath,
    clips,
    language: opts.language,
    onStage: opts.onStage,
  });
  return outDir;
}

/** 读取结构化阶段输入：meta +（人工编辑过的）transcript，并按 clips.json 重打 clipIndex */
export async function loadStructureInput(
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
export async function finalizeCourse(
  outDir: string,
  transcript: Transcript,
  meta: ForgeMeta,
  chains: DraftChain[],
): Promise<void> {
  const isVideo = Boolean(meta.videoPath);
  const ordered = [...chains].sort((a, b) => a.index - b.index);
  const statements = ordered.flatMap((c) => c.statements);
  // 与 statements 等长：缺 span 的链（旧进度快照 / 空句）补 null，交给 align 的兜底匹配
  const spans = ordered.flatMap((c) =>
    c.spans && c.spans.length === c.statements.length ? c.spans : c.statements.map(() => null),
  );
  const { timings, report } = alignStatements(transcript, statements, spans);
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
  const chains = await generateDraft(transcript);
  const statementCount = chains.reduce((n, c) => n + c.statements.length, 0);
  console.log(
    `[forge] 结构化完成：1 课（单一课程，逐句并发生成的组装链已按句序合并）/ ${statementCount} 条 statement`,
  );

  opts.onStage?.("aligning");
  await finalizeCourse(outDir, transcript, meta, chains);
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
      success: chains.map((c) => ({
        index: c.index,
        statements: c.statements,
        spans: c.spans,
      })),
      failures,
    };
    await writeJson(paths.progress(outDir), progress);
    console.log(`[forge] 结构化有 ${failures.length} 句未通过校验，已落盘进度等待人工处理`);
    return { needsFix: true };
  }

  const statementCount = chains.reduce((n, c) => n + c.statements.length, 0);
  console.log(
    `[forge] 结构化完成：1 课（单一课程，逐句并发生成的组装链已按句序合并）/ ${statementCount} 条 statement`,
  );
  opts.onStage?.("aligning");
  await finalizeCourse(outDir, transcript, meta, chains);
  opts.onStage?.("done");
  return { needsFix: false };
}

export function validateResolveDecisions(
  decisions: ResolveDecision[],
  progress: StructureProgress,
): void {
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

/**
 * resolve 合并（纯函数）：保留未决策的成功句 → 丢弃 delete/retry 句 → 拼上本轮重试结果 → 按句序排序。
 * 旧进度快照没有 spans，补齐为等长 null，交给 align 的兜底匹配。
 * legacy（forgeStructureResolve）与 graph（retryBatch）共用，避免两条路径的合并语义分叉。
 */
export function mergeResolveChains(input: {
  success: StructureProgress["success"];
  deleteIndexes: Set<number>;
  retryIndexes: Set<number>;
  retriedChains: DraftChain[];
}): DraftChain[] {
  const kept: DraftChain[] = input.success
    .filter((s) => !input.deleteIndexes.has(s.index) && !input.retryIndexes.has(s.index))
    .map((s) => ({
      index: s.index,
      statements: s.statements,
      spans:
        s.spans && s.spans.length === s.statements.length ? s.spans : s.statements.map(() => null),
    }));
  return [...kept, ...input.retriedChains].sort((a, b) => a.index - b.index);
}

/** resolve 续跑：只重跑 retry 句、丢掉 delete 句，与已成功句合并后收尾 */
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
  let newChains: DraftChain[] = [];
  let newFailures: SentenceFailure[] = [];
  if (retryIndexes.length > 0) {
    const result = await generateDraftCollected(transcript, retryIndexes);
    newChains = result.chains;
    newFailures = result.failures;
  }

  const failures = [...newFailures].sort((a, b) => a.index - b.index);

  const merged = mergeResolveChains({
    success: progress.success,
    deleteIndexes: deleteSet,
    retryIndexes: retrySet,
    retriedChains: newChains,
  });

  if (failures.length > 0) {
    const next: StructureProgress = {
      success: merged.map((c) => ({ index: c.index, statements: c.statements, spans: c.spans })),
      failures,
    };
    await writeJson(paths.progress(outDir), next);
    console.log(`[forge] 处理后仍有 ${failures.length} 句未通过校验，已更新进度等待人工处理`);
    return { needsFix: true };
  }

  if (merged.every((c) => c.statements.length === 0)) {
    throw new Error("[forge] 处理后没有任何句子，无法生成课程");
  }
  opts.onStage?.("aligning");
  await finalizeCourse(outDir, transcript, meta, merged);
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

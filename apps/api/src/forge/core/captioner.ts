/**
 * 音频打标（qwen-audio-3.1-captioner）的**编排层**：拿句子级时间戳给转写切块当边界。
 *
 * 传输与解析已经拆到 `captioner-model.ts`：
 *   - `DashScopeCaptionerChatModel` 负责「上传临时 OSS → 提交异步任务 → 轮询 → 下载 → 解析」，
 *     因此这一在整个 Langfuse trace 里是一条名为 `caption` 的 generation（与 asr 同构）。
 *   - 纯解析函数（`parseCaptionResult` / `parseClockToMs` / `stripCaptionTags`）也搬了过去，
 *     此处 re-export 保持既有 import 路径不变（与 `asr.ts` re-export `parseSyncSentence` 一致）。
 * 本文件只保留：ffmpeg 转码（不是模型调用，不进 generation 时长）、端点/Key/超时的编排与告警。
 *
 * ## 为什么不是直接读 `transcripts[].sentences[]`
 *
 * 实测（`scripts/probe-captioner.ts`，57s 素材）：captioner 返回的 `sentences` 只有
 * **一条**，覆盖整个文件，其 `text` 字段里装的是整段标注 JSON 字符串：
 *
 *   transcripts[0].sentences = [{ begin_time: 0, end_time: 57005, text: "{\"sound_segments\":…}" }]
 *
 * 真正的句/段级边界在 `transcripts[0].text`（JSON 字符串）的 `speech_segments[]` 里：
 *   { start: "00:01.60", end: "00:04.48", language: ["英文-通用美式"], text: "[说话人:x][语气:y]…" }
 *
 * 所以解析优先级是 speech_segments → sentences[]（时间可用但粒度粗）→ 用时长兜底成整段。
 * 段文本里带 `[说话人:..][语气:..][音效=..]` 标记，本模块只判断「有没有语音」
 * （去掉方括号标记后是否还剩文字），**不取文本**——文本由 asr-flash 逐块给。
 */
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { HumanMessage } from "@langchain/core/messages";

import type { ParsedCaption } from "./captioner-model";
import type { DashScopeTransportDeps } from "./dashscope-oss";
import type { ClipRange } from "./types";
import { transcodeToWav } from "./asr";
import { buildCaptionerModel, captionInputSummary, captionResultOf } from "./captioner-model";
import { config } from "./config";
import { resolveDashScopeEndpoints } from "./dashscope-oss";

export { parseCaptionResult, parseClockToMs, stripCaptionTags } from "./captioner-model";
export type { ParsedCaption, SpeechSpanMs } from "./captioner-model";

export interface CaptionMediaArgs {
  /** 原始媒体路径（音频或视频，ffmpeg 会提取音轨） */
  mediaPath: string;
  /** 有切片时只标注该区间（秒） */
  clip?: ClipRange;
  /** 单元序号：用于命名 wav 与日志 */
  unitIndex: number;
  /** 工作目录（通常是 outDir/.work） */
  workDir: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  transport?: DashScopeTransportDeps;
}

export interface CaptionMediaResult extends ParsedCaption {
  unitIndex: number;
  baseMs: number;
  taskId: string;
  model: string;
  /** 本地转码产物（后续切块直接用它，避免重复转码） */
  wavPath: string;
}

let warnedFallbackBase = false;

/** captioner 端点：未单独配置时回退 ASR 的 origin（同一 workspace 域名） */
function captionerEndpoints(baseUrl?: string) {
  const explicit = baseUrl ?? config.captionerBaseUrl;
  if (explicit.trim()) return resolveDashScopeEndpoints(explicit.trim());
  if (!warnedFallbackBase) {
    warnedFallbackBase = true;
    console.warn(
      "[captioner] 未配置 FORGE_CAPTIONER_BASE_URL，回退 FORGE_ASR_BASE_URL 的 origin；" +
        "若该域名未开通 captioner（如公网 dashscope.aliyuncs.com），请显式配置 workspace 域名",
    );
  }
  return resolveDashScopeEndpoints(config.asrBaseUrl);
}

/** 16k 单声道 16-bit PCM ≈ 32000 字节/秒（含 44 字节 wav 头），只用于追踪展示 */
function estimateDurationSec(fileBytes: number | undefined): number | undefined {
  return fileBytes === undefined ? undefined : Number(((fileBytes - 44) / 32000).toFixed(2));
}

/**
 * 标注一个 unit（整段或一个 clip）：转码 wav → 模型调用（上传/提交/轮询/下载）→ 解析。
 * 返回的 `spans` 时间相对**该 unit 的 wav 文件**（从 0 开始），调用方加 `baseMs` 得绝对时间。
 *
 * 转码刻意留在模型 span 之外：ffmpeg 不是模型调用，失败语义是「媒体不可用」，
 * 混进来只会污染 generation 的延迟统计。
 */
export async function captionMedia(args: CaptionMediaArgs): Promise<CaptionMediaResult> {
  const model = args.model ?? config.captionerModel;
  // 用 || 而不是 ??: 未配置时 env() 返回的是空串，?? 不会回退到 ASR 的 Key
  const apiKey = args.apiKey || config.captionerApiKey || config.asrApiKey;
  const endpoints = captionerEndpoints(args.baseUrl);
  const timeoutMs = args.timeoutMs ?? config.captionerTimeoutMs;
  const pollIntervalMs = args.pollIntervalMs ?? config.captionerPollIntervalMs;
  const pollTimeoutMs = args.pollTimeoutMs ?? config.captionerPollTimeoutMs;
  const transport: DashScopeTransportDeps = {
    ...args.transport,
    log: args.transport?.log ?? ((m) => console.log(m)),
  };

  const name = args.clip ? `unit-${args.unitIndex}.wav` : "unit-full.wav";
  const wavPath = resolve(args.workDir, "units", name);
  await transcodeToWav(args.mediaPath, wavPath, args.clip);
  const baseMs = args.clip ? Math.round(args.clip.start * 1000) : 0;

  // 只用于 invocationParams / trace 展示，失败不影响主流程
  const fileBytes = await stat(wavPath)
    .then((s) => s.size)
    .catch(() => undefined);
  const durationSec = estimateDurationSec(fileBytes);

  const message = await buildCaptionerModel({
    wavPath,
    unitIndex: args.unitIndex,
    baseMs,
    model,
    apiKey,
    endpoints,
    timeoutMs,
    pollIntervalMs,
    pollTimeoutMs,
    durationSec,
    fileBytes,
    transport,
  })
    .withConfig({
      runName: "caption",
      // 结构化字段走 metadata：Langfuse 会把它们并到这条观测上，便于按模型/unit 筛选
      metadata: {
        caption: {
          model,
          unit_index: args.unitIndex,
          base_ms: baseMs,
          wav_path: wavPath,
          duration_sec: durationSec,
          file_bytes: fileBytes,
          channel_id: 0,
          poll_interval_ms: pollIntervalMs,
          poll_timeout_ms: pollTimeoutMs,
        },
      },
    })
    .invoke([
      new HumanMessage(
        captionInputSummary({
          wavName: name,
          durationSec,
          fileBytes,
          unitIndex: args.unitIndex,
          channelId: 0,
        }),
      ),
    ]);

  const parsed = captionResultOf(message);
  const taskId = (message.response_metadata as { task_id?: unknown }).task_id;
  if (typeof taskId !== "string" || !taskId) {
    throw new Error("[captioner] 模型返回缺少 task_id（不应发生：检查 _generate 实现）");
  }

  return {
    ...parsed,
    unitIndex: args.unitIndex,
    baseMs,
    taskId,
    model,
    wavPath,
  };
}

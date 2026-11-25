/**
 * 音频打标（qwen-audio-3.1-captioner）客户端：拿**句子级时间戳**给转写切块当边界。
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
import { resolve } from "node:path";

import type { DashScopeTransportDeps } from "./dashscope-oss";
import type { ClipRange } from "./types";
import { transcodeToWav } from "./asr";
import { config } from "./config";
import {
  downloadJson,
  pollAsyncTask,
  resolveDashScopeEndpoints,
  submitAsyncTranscription,
  uploadToTemporaryOss,
} from "./dashscope-oss";

/** 一段有语音的时间区间（毫秒，相对被标注的音频文件） */
export interface SpeechSpanMs {
  beginMs: number;
  endMs: number;
}

export interface ParsedCaption {
  /** 有语音的段，升序、互不重叠、已过滤非法值 */
  spans: SpeechSpanMs[];
  /** 数据来自哪里：speech_segments（正常）/ sentences（粗粒度）/ duration（整段兜底） */
  source: "speech_segments" | "sentences" | "duration";
  channelDurationMs?: number;
}

/** 去掉 `[说话人:x]`、`[语气:y]`、`[音效=z]` 这类标注标记 */
export function stripCaptionTags(text: unknown): string {
  return String(text ?? "")
    .replace(/\[[^\]]*\]/g, "")
    .trim();
}

/**
 * `MM:SS.cc` / `HH:MM:SS.cc` / 纯数字（毫秒）→ 毫秒。
 *
 * 关键点：小数部分是**百分秒**，必须右补零到 3 位再当毫秒——`"00:06.08"` 是 6080ms，
 * 不是 608ms。解析失败返回 null（单条脏数据不应毁掉整个任务）。
 */
export function parseClockToMs(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.round(value) : null;
  }
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  // 跨段时 speech_segments.start 可能为负（官方文档明确写了），符号挂在整串最前面
  const negative = raw.startsWith("-");
  const body = negative ? raw.slice(1) : raw;
  const parts = body.split(":");
  if (parts.length < 2 || parts.length > 3) return null;

  const secPart = parts[parts.length - 1] ?? "";
  const secMatch = secPart.match(/^(\d+)(?:\.(\d+))?$/);
  if (!secMatch) return null;
  const whole = Number(secMatch[1]);
  // 小数位右补零到 3 位：".08" → 080ms，".5" → 500ms
  const fracMs = Number((secMatch[2] ?? "").padEnd(3, "0").slice(0, 3) || 0);

  const minutes = Number(parts[parts.length - 2]);
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  if (![minutes, hours, whole].every((n) => Number.isFinite(n))) return null;
  const total = (hours * 3600 + minutes * 60 + whole) * 1000 + fracMs;
  return negative ? -Math.round(total) : Math.round(total);
}

function normalizeSpans(
  items: Array<{ beginMs: number | null; endMs: number | null }>,
): SpeechSpanMs[] {
  return items
    .filter((x): x is { beginMs: number; endMs: number } => x.beginMs !== null && x.endMs !== null)
    .map((x) => ({ beginMs: Math.max(0, x.beginMs), endMs: Math.max(0, x.endMs) }))
    .filter((x) => x.endMs > x.beginMs)
    .sort((a, b) => a.beginMs - b.beginMs);
}

function snippet(json: unknown): string {
  try {
    return JSON.stringify(json).slice(0, 400);
  } catch {
    return String(json).slice(0, 400);
  }
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * 解析标注结果文件，返回有语音的时间段。
 *
 * 顺序：`transcripts[].text` 里的 `speech_segments`（过滤无语音段）
 * → `transcripts[].sentences[]`（时间可用、粒度粗）
 * → `content_duration_in_milliseconds` 兜底成 [0, duration]
 * → 都拿不到则抛错（用户要求：任何失败整体报错）。
 */
export function parseCaptionResult(json: unknown, channelId = 0): ParsedCaption {
  const body = json as {
    transcripts?: unknown;
    properties?: { original_duration_in_milliseconds?: number };
  };
  const list = Array.isArray(body?.transcripts)
    ? (body.transcripts as Array<Record<string, unknown>>)
    : Object.values((body?.transcripts ?? {}) as Record<string, Record<string, unknown>>);
  const channel = list.find((t) => Number(t?.channel_id) === channelId) ?? list[0];
  if (!channel) {
    throw new Error(`[captioner] 标注结果里没有 transcripts：${snippet(json)}`);
  }

  const channelDurationMs = Number(channel.content_duration_in_milliseconds);
  const durationMs = Number.isFinite(channelDurationMs)
    ? channelDurationMs
    : Number(body.properties?.original_duration_in_milliseconds);

  // 1) speech_segments：真正的段级边界
  const annotation = parseMaybeJson(channel.text) as {
    speech_segments?: Array<Record<string, unknown>>;
  } | null;
  const speechSegments = annotation?.speech_segments ?? [];
  const fromSegments = normalizeSpans(
    speechSegments
      .filter((s) => stripCaptionTags(s?.text).length > 0)
      .map((s) => ({
        beginMs: parseClockToMs(s?.start ?? s?.start_time),
        endMs: parseClockToMs(s?.end ?? s?.end_time),
      })),
  );
  if (fromSegments.length > 0) {
    return {
      spans: fromSegments,
      source: "speech_segments",
      channelDurationMs: Number.isFinite(durationMs) ? durationMs : undefined,
    };
  }

  // 2) sentences[]：captioner 实测只有一条覆盖全文件；作为容错保留
  const sentences = (channel.sentences ?? []) as Array<Record<string, unknown>>;
  const fromSentences = normalizeSpans(
    sentences.map((s) => ({
      beginMs: parseClockToMs(s?.begin_time),
      endMs: parseClockToMs(s?.end_time),
    })),
  );
  if (fromSentences.length > 0) {
    return {
      spans: fromSentences,
      source: "sentences",
      channelDurationMs: Number.isFinite(durationMs) ? durationMs : undefined,
    };
  }

  // 3) 只有时长（纯音乐/静音）：交给上层按 180s 等分
  if (Number.isFinite(durationMs) && durationMs > 0) {
    return {
      spans: [{ beginMs: 0, endMs: Math.round(durationMs) }],
      source: "duration",
      channelDurationMs: Math.round(durationMs),
    };
  }

  throw new Error(
    `[captioner] 未解析到任何语音时间段（speech_segments / sentences / 时长全为空）：${snippet(json)}`,
  );
}

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

/**
 * 标注一个 unit（整段或一个 clip）：转码 wav → 上传临时 OSS → 异步任务 → 下载 → 解析。
 * 返回的 `spans` 时间相对**该 unit 的 wav 文件**（从 0 开始），调用方加 `baseMs` 得绝对时间。
 */
export async function captionMedia(args: CaptionMediaArgs): Promise<CaptionMediaResult> {
  const model = args.model ?? config.captionerModel;
  // 用 || 而不是 ??: 未配置时 env() 返回的是空串，?? 不会回退到 ASR 的 Key
  const apiKey = args.apiKey || config.captionerApiKey || config.asrApiKey;
  const endpoints = captionerEndpoints(args.baseUrl);
  const timeoutMs = args.timeoutMs ?? config.captionerTimeoutMs;
  const transport: DashScopeTransportDeps = {
    ...args.transport,
    log: args.transport?.log ?? ((m) => console.log(m)),
  };

  const name = args.clip ? `unit-${args.unitIndex}.wav` : "unit-full.wav";
  const wavPath = resolve(args.workDir, "units", name);
  await transcodeToWav(args.mediaPath, wavPath, args.clip);
  const baseMs = args.clip ? Math.round(args.clip.start * 1000) : 0;

  const uploaded = await uploadToTemporaryOss(wavPath, {
    endpoints,
    model,
    apiKey,
    timeoutMs,
    ...transport,
  });
  const submitted = await submitAsyncTranscription({
    endpoints,
    model,
    apiKey,
    fileUrl: uploaded.ossUrl,
    parameters: { channel_id: [0] },
    timeoutMs,
    ...transport,
  });
  console.log(`[captioner] unit ${args.unitIndex} 任务已提交：${submitted.taskId}`);

  const polled = await pollAsyncTask(submitted.taskId, {
    endpoints,
    apiKey,
    intervalMs: args.pollIntervalMs ?? config.captionerPollIntervalMs,
    timeoutMs: args.pollTimeoutMs ?? config.captionerPollTimeoutMs,
    requestTimeoutMs: timeoutMs,
    onTick: (status, elapsedMs) =>
      console.log(
        `[captioner] unit ${args.unitIndex} ${status}（${Math.round(elapsedMs / 1000)}s）`,
      ),
    ...transport,
  });

  const json = await downloadJson(polled.transcriptionUrl, { timeoutMs, ...transport });
  const parsed = parseCaptionResult(json, 0);
  console.log(
    `[captioner] unit ${args.unitIndex} 完成：${parsed.spans.length} 段语音` +
      `（source=${parsed.source}，时长 ${((parsed.channelDurationMs ?? 0) / 1000).toFixed(1)}s）`,
  );

  return {
    ...parsed,
    unitIndex: args.unitIndex,
    baseMs,
    taskId: submitted.taskId,
    model,
    wavPath,
  };
}

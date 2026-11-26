/**
 * captioner（音频打标）的 LangChain 传输层：把百炼 `qwen-audio-captioner` 的**异步任务**
 * 封成一个 `BaseChatModel`，让它在 Langfuse 里和 ASR / LLM 一样成一条 generation 观测。
 *
 * 与 `asr-model.ts` 的关系（看代码前先分清）：
 *   - 同族：都是 DashScope 原生协议、都只把**元信息**交给 callback 层、都不实现
 *     `_streamResponseChunks`（一次返回完整结果）、都由 `buildXxxModel()` 兜底挂 handler。
 *   - 不同：asr 是同步 `multimodal-generation`，音频以 base64 data URI 内联；
 *     captioner 是**异步任务**（上传临时 OSS → 提交 → 轮询 → 下载），根本没有 base64，
 *     但一次 `_generate` 可能跑几分钟（轮询）。
 *
 * 两条硬约束（改之前必看）：
 *   a. **本地路径只能走构造参数，不能放进 messages**。messages 会被 callback 层序列化进 trace；
 *      wav 动辄几十 MB，绝对路径也不该出现在可读入参里。所以 `invocationParams()` 只暴露
 *      model / 声道 / unit / 时长 / 字节数。
 *   b. **不要为了「更细的粒度」在 `_generate` 里手动 `startObservation()`**。`@langfuse/langchain`
 *      的 handler 用显式 `parentSpanContext` 建 span（`endOnExit:false`），节点函数体执行期间
 *      上下文里没有活跃 span，手动观测会变成**新的 root trace**，一次流水线散成几十条。
 *      要新观测就用 Runnable（本文件这个类就是）。
 *
 * 为什么解析函数（`parseCaptionResult` 等）也在这个文件：`captioner.ts` 要 import 本文件的
 * 模型，若解析函数留在 `captioner.ts` 就形成循环依赖。`captioner.ts` 做了 re-export，
 * 既有 import 路径不变。
 */
import { basename } from "node:path";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";

import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";

import type { DashScopeEndpoints, DashScopeTransportDeps } from "./dashscope-oss";
import {
  downloadJson,
  pollAsyncTask,
  submitAsyncTranscription,
  uploadToTemporaryOss,
} from "./dashscope-oss";
import { legacyModelCallbacks } from "./tracing";

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

/** `additional_kwargs` 里携带语音段的键名（供 captionResultOf 取回毫秒区间） */
export const CAPTION_SPANS_KEY = "caption_spans";

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

/** 从模型返回的消息里取回语音段（毫秒，相对 unit wav）。缺键直接抛错，避免静默拿到空切块计划 */
export function captionSpansOf(message: BaseMessage): SpeechSpanMs[] {
  const raw = message.additional_kwargs?.[CAPTION_SPANS_KEY];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      `[captioner] 模型返回的消息里没有 ${CAPTION_SPANS_KEY}（不应发生：检查 _generate 实现）`,
    );
  }
  return raw as SpeechSpanMs[];
}

/** 从模型返回的消息重组 `ParsedCaption`（spans 在 additional_kwargs，source/时长在 response_metadata） */
export function captionResultOf(message: BaseMessage): ParsedCaption {
  const spans = captionSpansOf(message);
  const meta = (message.response_metadata ?? {}) as {
    source?: unknown;
    channel_duration_ms?: unknown;
  };
  const source = meta.source;
  if (source !== "speech_segments" && source !== "sentences" && source !== "duration") {
    throw new Error(
      "[captioner] 模型返回的消息里缺少合法的 response_metadata.source" +
        "（不应发生：检查 _generate 实现）",
    );
  }
  return {
    spans,
    source,
    channelDurationMs:
      typeof meta.channel_duration_ms === "number" ? meta.channel_duration_ms : undefined,
  };
}

/** 构造 captioner 观测的「人类可读入参」：只有元信息，本地路径与音频本体都不进 messages */
export function captionInputSummary(input: {
  wavName: string;
  durationSec?: number;
  fileBytes?: number;
  unitIndex: number;
  channelId: number;
}): string {
  const mb =
    input.fileBytes === undefined ? "未知" : `${(input.fileBytes / 1024 / 1024).toFixed(2)} MB`;
  return [
    "音频打标（DashScope Qwen-Audio-Captioner，异步任务，仅取句级时间戳）",
    `- 文件：${input.wavName}（wav / 16 kHz / 单声道 / 16-bit PCM）`,
    `- 体积：${mb}（上传临时 OSS，不内联进请求体/追踪）`,
    ...(input.durationSec === undefined ? [] : [`- 时长：${input.durationSec.toFixed(1)}s`]),
    `- unit：${input.unitIndex}，声道：${input.channelId}`,
    "说明：只保留 speech_segments 的起止时间，段文本不进入本步骤与 trace。",
  ].join("\n");
}

/** 构造 captioner 观测的可读输出：Langfuse 的 output 只取消息 content，关键指标必须写在这里 */
export function captionOutputSummary(input: {
  model: string;
  taskId: string;
  source: ParsedCaption["source"];
  spanCount: number;
  pollElapsedMs: number;
  channelDurationMs?: number;
  unitIndex: number;
}): string {
  return [
    `音频打标完成（${input.model}，异步任务）`,
    `- unit：${input.unitIndex}`,
    `- 任务：${input.taskId}（轮询 ${(input.pollElapsedMs / 1000).toFixed(1)}s）`,
    `- 结果：${input.spanCount} 段语音（source=${input.source}${
      input.channelDurationMs === undefined
        ? ""
        : `，时长 ${(input.channelDurationMs / 1000).toFixed(1)}s`
    }）`,
    "说明：仅用于切块的句级边界；段文本由后续 asr-flash 提供。",
  ].join("\n");
}

export interface CaptionerModelFields extends BaseChatModelParams {
  /** 已转码好的 unit wav。只走构造参数，绝不进 messages（wav 可能几十 MB） */
  wavPath: string;
  unitIndex: number;
  /** clip 起点（毫秒），仅用于追踪展示：spans 本身是相对 unit wav 的 */
  baseMs?: number;
  /** 声道，默认 0 */
  channelId?: number;
  /** 以下由 captionMedia 解析后传入：模型不读 config，也不复制 captionerEndpoints 的告警逻辑 */
  model: string;
  apiKey: string;
  endpoints: DashScopeEndpoints;
  /** 单次 HTTP 超时（getPolicy / 提交 / 查询 / 下载各自） */
  timeoutMs?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** 仅用于 invocationParams 展示（由 captionMedia stat 出来） */
  durationSec?: number;
  fileBytes?: number;
  /** 单测注入 fetch/sleep/now/log */
  transport?: DashScopeTransportDeps;
}

/**
 * DashScope Qwen-Audio-Captioner 的 ChatModel 封装（异步任务：上传 → 提交 → 轮询 → 下载）。
 *
 * 用法（唯一入口见 `captioner.ts: captionMedia()`）：
 * ```ts
 * const model = buildCaptionerModel({ wavPath, unitIndex, model, apiKey, endpoints });
 * const msg = await model.invoke([new HumanMessage(captionInputSummary(...))]);
 * const parsed = captionResultOf(msg);
 * ```
 * 消息内容只影响 trace 里的可读输入，不影响请求体（文件路径固定在构造参数里）。
 */
export class DashScopeCaptionerChatModel extends BaseChatModel {
  private readonly wavPath: string;
  private readonly unitIndex: number;
  private readonly baseMs?: number;
  private readonly channelId: number;
  private readonly modelName: string;
  private readonly apiKey: string;
  private readonly endpoints: DashScopeEndpoints;
  private readonly timeoutMs?: number;
  private readonly pollIntervalMs?: number;
  private readonly pollTimeoutMs?: number;
  private readonly durationSec?: number;
  private readonly fileBytes?: number;
  private readonly transport: DashScopeTransportDeps;

  constructor(fields: CaptionerModelFields) {
    super(fields);
    this.wavPath = fields.wavPath;
    this.unitIndex = fields.unitIndex;
    this.baseMs = fields.baseMs;
    this.channelId = fields.channelId ?? 0;
    this.modelName = fields.model;
    this.apiKey = fields.apiKey;
    this.endpoints = fields.endpoints;
    this.timeoutMs = fields.timeoutMs;
    this.pollIntervalMs = fields.pollIntervalMs;
    this.pollTimeoutMs = fields.pollTimeoutMs;
    this.durationSec = fields.durationSec;
    this.fileBytes = fields.fileBytes;
    this.transport = fields.transport ?? {};
  }

  _llmType(): string {
    return "dashscope-captioner";
  }

  /** 交给 callback 层的入参摘要：只有元信息，**不含**本地绝对路径与音频内容（见文件头约束 a） */
  invocationParams(): Record<string, unknown> {
    return {
      model: this.modelName,
      provider: "dashscope",
      mode: "async-task",
      channel_id: this.channelId,
      unit_index: this.unitIndex,
      base_ms: this.baseMs,
      wav_name: basename(this.wavPath),
      duration_sec:
        this.durationSec === undefined ? undefined : Number(this.durationSec.toFixed(2)),
      file_bytes: this.fileBytes,
      poll_interval_ms: this.pollIntervalMs,
      poll_timeout_ms: this.pollTimeoutMs,
    };
  }

  async _generate(
    _messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const log = this.transport.log ?? ((m: string) => console.log(m));
    const now = this.transport.now ?? (() => Date.now());
    const startedAt = now();

    try {
      // 上传 → 提交 → 轮询 → 下载 → 解析：一次异步任务的完整生命周期都在这个 span 里，
      // 时长因此包含排队与轮询（默认最多 pollTimeoutMs），这是拿到 spans 的必然代价。
      const uploaded = await uploadToTemporaryOss(this.wavPath, {
        endpoints: this.endpoints,
        model: this.modelName,
        apiKey: this.apiKey,
        timeoutMs: this.timeoutMs,
        ...this.transport,
      });
      const submitted = await submitAsyncTranscription({
        endpoints: this.endpoints,
        model: this.modelName,
        apiKey: this.apiKey,
        fileUrl: uploaded.ossUrl,
        parameters: { channel_id: [this.channelId] },
        timeoutMs: this.timeoutMs,
        ...this.transport,
      });
      log(`[captioner] unit ${this.unitIndex} 任务已提交：${submitted.taskId}`);

      const pollStarted = now();
      const polled = await pollAsyncTask(submitted.taskId, {
        endpoints: this.endpoints,
        apiKey: this.apiKey,
        intervalMs: this.pollIntervalMs ?? 3000,
        timeoutMs: this.pollTimeoutMs ?? 10 * 60 * 1000,
        requestTimeoutMs: this.timeoutMs,
        onTick: (status, elapsedMs) =>
          log(`[captioner] unit ${this.unitIndex} ${status}（${Math.round(elapsedMs / 1000)}s）`),
        ...this.transport,
      });
      const pollElapsedMs = now() - pollStarted;

      const json = await downloadJson(polled.transcriptionUrl, {
        timeoutMs: this.timeoutMs,
        ...this.transport,
      });
      const parsed = parseCaptionResult(json, this.channelId);
      log(
        `[captioner] unit ${this.unitIndex} 完成：${parsed.spans.length} 段语音` +
          `（source=${parsed.source}，时长 ${((parsed.channelDurationMs ?? 0) / 1000).toFixed(1)}s）`,
      );

      // content 是唯一会进 Langfuse output 的字段（handler 对 AI 消息只取 content/role/tool_calls），
      // 所以关键指标写进摘要；结构化字段放 response_metadata 供进程内与单测读取。
      const content = captionOutputSummary({
        model: this.modelName,
        taskId: submitted.taskId,
        source: parsed.source,
        spanCount: parsed.spans.length,
        pollElapsedMs,
        channelDurationMs: parsed.channelDurationMs,
        unitIndex: this.unitIndex,
      });

      const message = new AIMessage({
        content,
        // spans 每条只有两个毫秒整数，几十条 ≈ 1~2KB；且 AI 消息的 additional_kwargs 不会被上报
        additional_kwargs: { [CAPTION_SPANS_KEY]: parsed.spans },
        response_metadata: {
          model: this.modelName,
          model_name: this.modelName,
          task_id: submitted.taskId,
          source: parsed.source,
          span_count: parsed.spans.length,
          channel_duration_ms: parsed.channelDurationMs,
          poll_elapsed_ms: pollElapsedMs,
          total_elapsed_ms: now() - startedAt,
          upload_bytes: uploaded.bytes,
          unit_index: this.unitIndex,
          base_ms: this.baseMs,
        },
      });

      return {
        generations: [{ text: content, message }],
        // 该端点不返回 token 用量，只把请求标识写进 llmOutput 供追踪对照
        llmOutput: {
          model: this.modelName,
          task_id: submitted.taskId,
          source: parsed.source,
          span_count: parsed.spans.length,
          poll_elapsed_ms: pollElapsedMs,
          upload_bytes: uploaded.bytes,
        },
      };
    } catch (error) {
      // 多 unit 串行时，让 generation 的 statusMessage 直接看出是哪个 unit 失败
      if (error instanceof Error && !error.message.startsWith("[captioner] unit ")) {
        // tsconfig target 是 ES2021，ErrorOptions.cause 不可用；原始信息已拼进 message
        throw new Error(`[captioner] unit ${this.unitIndex} 打标失败：${error.message}`);
      }
      throw error;
    }
  }
}

/**
 * 构造 captioner 模型。
 *
 * 兜底挂 handler 的规则与 asr-model / llm-client 完全一致：图内已经由图根 callbacks 经
 * AsyncLocalStorage 继承下来，再挂就重复上报；图外（legacy 编排）没有根可继承，必须自己挂。
 */
export function buildCaptionerModel(fields: CaptionerModelFields): DashScopeCaptionerChatModel {
  const callbacks = legacyModelCallbacks();
  return new DashScopeCaptionerChatModel({
    ...fields,
    ...(callbacks.length > 0 ? { callbacks } : {}),
  });
}

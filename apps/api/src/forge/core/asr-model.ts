/**
 * ASR 的 LangChain 传输层：把 DashScope（百炼）原生 `multimodal-generation` 接口封成
 * 一个 `BaseChatModel`，让音频转写和 LLM 调用处在同一套 Runnable 生态里。
 *
 * 为什么是自定义 ChatModel，而不是 `ChatOpenAI` 或 AudioLoader：
 *   1. 这个端点是**非 OpenAI 兼容**的（`parameters.format/sample_rate/language_hints`
 *      入参、`output.sentence.words` 出参），`ChatOpenAI` 会把响应解析砸掉；
 *      而 OpenAI 风格的 transcription 抽象只给纯文本，正好丢掉本项目最依赖的**词级时间戳**。
 *   2. 自定义 BaseChatModel 保留原生协议，但白拿到 LangChain 的三件事：
 *      `invoke()` 统一入口、callback 继承（图内/legacy 都自动）、Langfuse 里成一条 LLM 观测。
 *
 * 两条硬约束（改之前必看）：
 *   a. **音频只能走构造参数，不能放进 messages**。messages 会被 callback 层序列化进 trace，
 *      5 分钟 16k wav 的 base64 约 13MB，足以把 Langfuse 的整批上报撑挂。
 *      所以 `invocationParams()` 只暴露 model/format/language/时长/字节数。
 *   b. **不实现 `_streamResponseChunks`**。DashScope 同步接口一次返回完整结果，
 *      默认实现只在被覆写时才会被用到（chat_models.js），因此始终走 `_generate`。
 */
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";

import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";

import { config } from "./config";
import { legacyModelCallbacks } from "./tracing";

/** DashScope Qwen-Audio-ASR 同步返回的词结构（时间戳单位毫秒） */
export interface QwenAsrWord {
  text?: string;
  begin_time?: number;
  end_time?: number;
  punctuation?: string;
}

/** DashScope Qwen-Audio-ASR 同步返回的句子结构（时间戳单位毫秒） */
export interface QwenAsrSentence {
  sentence_id?: number;
  begin_time?: number;
  end_time?: number;
  text?: string;
  sentence_end?: boolean;
  words?: QwenAsrWord[];
}

/** `additional_kwargs` 里携带原始句子的键名（供 transcribeWithRaw 取回未加工的毫秒数据） */
export const ASR_SENTENCES_KEY = "asr_sentences";

/**
 * 解析同步响应 JSON：output.sentence 为单个句子对象（整段 text + 全部词）。
 * 防御性兼容数组写法；错误载荷（code 且无 output）抛错。
 */
export function parseSyncSentence(json: unknown): QwenAsrSentence[] {
  const body = json as {
    code?: string;
    message?: string;
    output?: { sentence?: QwenAsrSentence | QwenAsrSentence[] };
  };
  if (body?.code && !body.output) {
    throw new Error(`[asr] 服务返回错误: ${body.code} ${body.message ?? ""}`.trim());
  }
  const sentence = body?.output?.sentence;
  if (!sentence) {
    throw new Error(`[asr] 同步响应缺少 output.sentence: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return Array.isArray(sentence) ? sentence : [sentence];
}

/** 从模型返回的消息里取回原始句子（毫秒时间戳，未经任何换算） */
export function asrSentencesOf(message: BaseMessage): QwenAsrSentence[] {
  const raw = message.additional_kwargs?.[ASR_SENTENCES_KEY];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      `[asr] 模型返回的消息里没有 ${ASR_SENTENCES_KEY}（不应发生：检查 _generate 实现）`,
    );
  }
  return raw as QwenAsrSentence[];
}

export interface AsrModelFields extends BaseChatModelParams {
  /** 音频 data URI（`data:audio/wav;base64,...`）。只放构造参数，绝不进 messages */
  audio: string;
  /** 识别语种提示，默认 en */
  language?: string;
  /** 音频时长（秒），仅用于追踪/日志展示 */
  durationSec?: number;
  /** 覆盖配置里的端点与模型（默认取 config.asr*） */
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * DashScope Qwen-Audio-ASR 的 ChatModel 封装。
 *
 * 用法（唯一入口见 `transcribeWithRaw`）：
 * ```ts
 * const model = buildAsrModel({ audio: dataUri, language: "en", durationSec: 300 });
 * const msg = await model.invoke([new HumanMessage("转写这段音频")]);
 * const sentences = asrSentencesOf(msg);
 * ```
 * 消息内容只影响 trace 里的可读输入，不影响请求体（音频固定在构造参数里）。
 */
export class DashScopeAsrChatModel extends BaseChatModel {
  private readonly audio: string;
  private readonly language: string;
  private readonly durationSec?: number;
  private readonly modelName: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(fields: AsrModelFields) {
    super(fields);
    this.audio = fields.audio;
    this.language = fields.language ?? "en";
    this.durationSec = fields.durationSec;
    this.modelName = fields.model ?? config.asrModel;
    this.apiKey = fields.apiKey ?? config.asrApiKey;
    this.baseUrl = fields.baseUrl ?? config.asrBaseUrl;
    this.timeoutMs = fields.timeoutMs ?? config.asrTimeoutMs;
  }

  _llmType(): string {
    return "dashscope-asr";
  }

  /** 交给 callback 层的入参摘要：只有元信息，**不含** base64（见文件头约束 a） */
  invocationParams(): Record<string, unknown> {
    return {
      model: this.modelName,
      provider: "dashscope",
      format: "wav",
      sample_rate: "16000",
      language_hints: [this.language],
      audio_seconds:
        this.durationSec === undefined ? undefined : Number(this.durationSec.toFixed(2)),
      // data URI 的字符数 ≈ base64 长度，反推原始字节数只用于展示
      audio_bytes: Math.round((this.audio.length * 3) / 4),
    };
  }

  async _generate(
    _messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    if (!this.apiKey) {
      throw new Error("[asr] 未配置 FORGE_ASR_API_KEY（百炼 DashScope API Key，sk- 开头）");
    }

    const body = JSON.stringify({
      model: this.modelName,
      input: {
        messages: [
          {
            role: "user",
            content: [{ type: "input_audio", input_audio: { data: this.audio } }],
          },
        ],
      },
      parameters: {
        format: "wav",
        sample_rate: "16000",
        language_hints: [this.language],
      },
    });

    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`[asr] 转写请求失败（HTTP ${res.status}）: ${detail.slice(0, 400)}`);
    }

    const json = (await res.json()) as { request_id?: string };
    const sentences = parseSyncSentence(json);
    const text = sentences
      .map((s) => (s.text ?? "").trim())
      .filter(Boolean)
      .join(" ");

    const message = new AIMessage({
      content: text,
      additional_kwargs: { [ASR_SENTENCES_KEY]: sentences },
      response_metadata: {
        model: this.modelName,
        request_id: json.request_id,
        sentence_count: sentences.length,
        word_count: sentences.reduce((n, s) => n + (s.words?.length ?? 0), 0),
      },
    });

    return {
      generations: [{ text, message }],
      // 该端点不返回 token 用量，只把请求标识写进 llmOutput 供追踪对照
      llmOutput: { model: this.modelName, request_id: json.request_id },
    };
  }
}

/**
 * 构造 ASR 模型。
 *
 * 兜底挂 handler 的规则与 llm-client 完全一致：图内已经由图根 callbacks 经
 * AsyncLocalStorage 继承下来，再挂就重复上报；图外（legacy 编排）没有根可继承，必须自己挂。
 */
export function buildAsrModel(fields: AsrModelFields): DashScopeAsrChatModel {
  const callbacks = legacyModelCallbacks();
  return new DashScopeAsrChatModel({
    ...fields,
    ...(callbacks.length > 0 ? { callbacks } : {}),
  });
}

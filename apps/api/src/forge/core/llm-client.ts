/**
 * LLM 调用层：把原来的手写 fetch（stream + SSE 手解析）换成 `@langchain/openai` 的 ChatOpenAI。
 *
 * 迁移原则：**只换传输，不换策略**。以下行为与重构前逐条对齐：
 *   1. 三级降级：json_schema → json_object → 纯文本（配合括号配对提取）；
 *   2. 始终流式（规避 undici 300s 超时），max_tokens / temperature 不变；
 *   3. 网络级失败（超时/连不上/连接中断/云端审核）立即失败，不做降级重试；
 *   4. `maxRetries: 0`：重试与降级都由本文件控制，避免 SDK 与降级链双重放大；
 *   5. 降级成功后缓存档位（进程内），后续句子直达，不必每句先失败一次。
 */
import { ChatOpenAI } from "@langchain/openai";

import { config } from "./config";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export const courseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["statements"],
  properties: {
    statements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["indexes", "chinese", "phonetic"],
        properties: {
          indexes: { type: "array", items: { type: "integer" } },
          chinese: { type: "string" },
          phonetic: { type: "string" },
        },
      },
    },
  },
} as const;

/**
 * 构建 ChatOpenAI 的 `modelKwargs`（纯函数）：只放「有值才发送」的厂商扩展字段。
 * reasoning_effort 置空串表示不发送（DashScope 等非 ollama 服务会拒绝该字段）；
 * enable_thinking 未设置时同样不发送（ollama 不认识）。
 */
export function buildModelKwargs(input: {
  reasoningEffort: string;
  enableThinking?: boolean;
  responseFormat?: Record<string, unknown>;
}): Record<string, unknown> {
  const kwargs: Record<string, unknown> = {};
  if (input.reasoningEffort) {
    kwargs.reasoning_effort = input.reasoningEffort;
  }
  if (input.enableThinking !== undefined) {
    kwargs.enable_thinking = input.enableThinking;
  }
  if (input.responseFormat) {
    kwargs.response_format = input.responseFormat;
  }
  return kwargs;
}

/** 构造 ChatOpenAI：始终流式（同重构前的 stream:true），超时 20 分钟，不自动重试 */
export function buildModel(
  model: string = config.llmModel,
  overrides: { modelKwargs?: Record<string, unknown> } = {},
): ChatOpenAI {
  const modelKwargs =
    overrides.modelKwargs ??
    buildModelKwargs({
      reasoningEffort: config.llmReasoningEffort,
      enableThinking: config.llmEnableThinking,
    });
  return new ChatOpenAI({
    model,
    apiKey: config.llmApiKey || "ollama",
    temperature: 0.1,
    maxTokens: config.llmMaxTokens,
    streaming: true,
    timeout: 20 * 60 * 1000,
    maxRetries: 0,
    configuration: { baseURL: config.llmBaseUrl },
    modelKwargs,
  });
}

/** 从可能带 markdown 围栏/杂文本的模型输出里提取第一个完整 JSON 对象 */
export function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  if (start < 0) {
    throw new Error(`LLM 输出中未找到 JSON: ${text.slice(0, 200)}`);
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return JSON.parse(body.slice(start, i + 1));
      }
    }
  }
  throw new Error(`LLM 输出的 JSON 不完整: ${text.slice(start, start + 200)}...`);
}

export type LlmFailureKind = "timeout" | "unreachable" | "network" | "moderation" | "other";

/**
 * 沿 error.cause 链归类网络级失败（纯函数，与重构前一致）：
 * undici 的 Headers/BodyTimeoutError、AbortSignal 的 TimeoutError -> timeout；
 * ECONNREFUSED/ENOTFOUND -> unreachable；其它 fetch failed 类 -> network；
 * 云端内容审核拦截（DashScope "inappropriate content" / DataInspectionFailed）-> moderation；
 * 应用层错误（如 LLM HTTP 4xx）-> other（允许降级重试）。
 */
export function classifyLlmFailure(error: unknown): { kind: LlmFailureKind; detail: string } {
  const parts: string[] = [];
  let cur: any = error;
  for (let hop = 0; cur && hop < 6; hop++) {
    parts.push(`${String(cur.name ?? "")} ${String(cur.code ?? "")} ${String(cur.message ?? "")}`);
    cur = cur.cause;
  }
  const detail = parts.join(" <- ").slice(0, 300);
  const blob = parts.join(" ").toLowerCase();
  if (/headertimeout|bodytimeout|timeouterror|timed out|timeout/.test(blob)) {
    return { kind: "timeout", detail };
  }
  if (/econnrefused|enotfound/.test(blob)) {
    return { kind: "unreachable", detail };
  }
  if (/fetch failed|econnreset|epipe|socket hang up/.test(blob)) {
    return { kind: "network", detail };
  }
  if (/inappropriate content|datainspectionfailed|data_inspection_failed/.test(blob)) {
    return { kind: "moderation", detail };
  }
  return { kind: "other", detail };
}

/**
 * DashScope 等 OpenAI 兼容服务在 response_format 为 json_object 时校验 messages 必须含
 * "json" 一词。提示词已精简（结构约束由代码承担），因此 json_object 降级分支补一条含关键词的
 * user 消息；json_schema 与纯文本分支不动 messages。
 */
export function messagesWithJsonKeyword(
  messages: ChatMessage[],
  format: Record<string, unknown> | undefined,
): ChatMessage[] {
  if (format?.type !== "json_object") {
    return messages;
  }
  return [...messages, { role: "user" as const, content: "Reply with a single JSON object." }];
}

/** 降级档位：json_schema（strict）→ json_object → 纯文本 */
type Rung = "jsonSchema" | "jsonObject" | "text";
const RUNGS: Rung[] = ["jsonSchema", "jsonObject", "text"];
/** 端点能力缓存：某档成功后直达，避免每句先失败一次（进程内有效） */
const okRungByModel = new Map<string, Rung>();

/** 单测用：重置能力缓存 */
export function resetRungCache(): void {
  okRungByModel.clear();
}

export async function callLlmJson(
  messages: ChatMessage[],
  schema: Record<string, unknown> = courseJsonSchema,
  model: string = config.llmModel,
): Promise<unknown> {
  const cached = okRungByModel.get(model);
  const startIndex = cached ? RUNGS.indexOf(cached) : 0;
  const candidates = RUNGS.slice(Math.max(0, startIndex));

  let lastError: unknown;
  for (const rung of candidates) {
    try {
      const content = await complete(messages, schema, model, rung);
      okRungByModel.set(model, rung);
      return extractJsonObject(content);
    } catch (error) {
      lastError = error;
      const { kind, detail } = classifyLlmFailure(error);
      // 网络级错误降级重试也没意义，直接抛出带准确指引的错误
      if (kind === "timeout") {
        throw new Error(
          `[llm] 响应超时：${config.llmBaseUrl} 在时限内未完成生成（服务卡死、显存换页或生成过长）。错误链: ${detail}`,
        );
      }
      if (kind === "unreachable") {
        throw new Error(
          `[llm] 无法连接 ${config.llmBaseUrl}。请确认服务已启动（Ollama 桌面托盘版会自动拉起服务，无需手动 \`ollama serve\`；纯命令行安装才需要）且模型已 \`ollama pull ${model}\`。错误链: ${detail}`,
        );
      }
      if (kind === "network") {
        throw new Error(
          `[llm] 与 ${config.llmBaseUrl} 的连接被中断（服务端进程可能崩溃/重启）。错误链: ${detail}`,
        );
      }
      if (kind === "moderation") {
        throw new Error(
          `[llm] 云端内容审核拦截：${config.llmBaseUrl} 判定 ${model} 的输出不合规并中断生成。` +
            `这是云端安全策略而非调用方式问题，重试/降级无效——可改用本地 ollama 端点重跑该句，` +
            `或人工处理该段转写的敏感内容。错误链: ${detail}`,
        );
      }
      console.warn(
        `[llm] ${rung} 方式失败，降级重试: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`,
      );
    }
  }
  throw new Error(`[llm] 结构化输出失败（已尝试全部降级方式）: ${(lastError as Error)?.message}`);
}

async function complete(
  messages: ChatMessage[],
  schema: Record<string, unknown>,
  model: string,
  rung: Rung,
): Promise<string> {
  if (rung === "jsonSchema") {
    const chat = buildModel(model);
    const structured = chat.withStructuredOutput(schema, {
      name: "structured_output",
      strict: true,
      method: "jsonSchema",
    });
    const output = await structured.invoke(messages as never);
    return typeof output === "string" ? output : JSON.stringify(output);
  }

  if (rung === "jsonObject") {
    const chat = buildModel(model, {
      modelKwargs: buildModelKwargs({
        reasoningEffort: config.llmReasoningEffort,
        enableThinking: config.llmEnableThinking,
        responseFormat: { type: "json_object" },
      }),
    });
    const res = await chat.invoke(
      messagesWithJsonKeyword(messages, { type: "json_object" }) as never,
    );
    return contentOf(res);
  }

  const chat = buildModel(model);
  const res = await chat.invoke(messages as never);
  return contentOf(res);
}

function contentOf(res: { content: unknown }): string {
  const content =
    typeof res.content === "string"
      ? res.content
      : Array.isArray(res.content)
        ? res.content
            .map((part) =>
              typeof part === "string" ? part : (part as { text?: string })?.text ?? "",
            )
            .join("")
        : JSON.stringify(res.content ?? "");
  if (!content.trim()) {
    throw new Error("LLM 返回内容为空");
  }
  return content;
}

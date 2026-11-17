import { z } from "zod";

import type { DraftCourse, DraftStatement, Transcript } from "./types";
import { normalizeToken } from "./align";
import { config } from "./config";
import { buildMessages } from "./prompt";

/**
 * LLM 输出的代码侧约束（不依赖提示词），按顺序：
 * 1. response_format：请求携带 json_schema（strict），字段名/必填/类型由服务端保证；
 *    服务端不支持时逐级降级 json_object -> 纯文本 + 括号配对提取（callLlmJson）。
 * 2. zod 结构校验（draftSchema）：兜底降级模式，并清洗 {"courses":[...]} 旧包裹。
 * 3. english 标点清理（normalizeStatementsEnglish）：见下方说明。
 * 4. 完整原句锚点校验（containsFullSentence）：保证模型没有把这一句丢弃或改写。
 *
 * 一次调用只处理一个句子（一句一调用，多句并发），因此输出就是一条 statement 组装链。
 */
export const draftSchema = z.object({
  statements: z
    .array(
      z.object({
        english: z.string().min(1),
        chinese: z.string().min(1),
        phonetic: z.string().optional(),
      }),
    )
    .min(1),
});

/** 容错：模型偶尔无视指令仍包一层 {"courses":[...]} 时，取第一门课 */
export function coerceCourseOutput(raw: unknown): unknown {
  if (raw && typeof raw === "object" && Array.isArray((raw as { courses?: unknown }).courses)) {
    const courses = (raw as { courses: unknown[] }).courses;
    if (courses.length > 0) {
      return courses[0];
    }
  }
  return raw;
}

/**
 * english 只允许：字母、数字、空格、撇号、连字符。
 * 撇号必须保留——don't / it's 里它属于拼写本身，删掉会变成 "dont"，
 * 既失真也破坏铁律 1 的"逐字来自转写"；连字符同理（t-shirt）。
 * 其余标点（. , ! ? " 等）替换为空格后折叠：用户是把碎片逐词拼成句子的，
 * english 带句读会破坏拼装与逐词对照。
 * chinese 不做清理：中文语义依赖标点（；、。（）），由模型输出直接采信。
 */
const NON_ENGLISH_PUNCT = /[^\p{L}\p{N}\s'’-]/gu;

export function stripEnglishPunctuation(text: string): string {
  return text.replace(NON_ENGLISH_PUNCT, " ").replace(/\s+/g, " ").trim();
}

/**
 * 校验并清理一遍模型返回的 statements：逐行剥掉 english 里的标点并就地写回。
 * 返回 changes（"原文 -> 清理后"清单，供日志）与 emptyIndexes
 * （清理后 english 变空白的行号，说明该行本来只有标点，调用方应判失败重试）。
 */
export function normalizeStatementsEnglish(statements: DraftStatement[]): {
  changes: string[];
  emptyIndexes: number[];
} {
  const changes: string[] = [];
  const emptyIndexes: number[] = [];
  statements.forEach((s, i) => {
    const cleaned = stripEnglishPunctuation(s.english);
    if (cleaned !== s.english) {
      changes.push(`[${i + 1}] "${s.english}" -> "${cleaned}"`);
      s.english = cleaned;
    }
    if (!cleaned) {
      emptyIndexes.push(i + 1);
    }
  });
  return { changes, emptyIndexes };
}

/** 结构化输出的 JSON Schema（strict 风格：全字段 required，可选用空串表达）；一次调用产出一条 statement 组装链 */
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
        required: ["english", "chinese", "phonetic"],
        properties: {
          english: { type: "string" },
          chinese: { type: "string" },
          phonetic: { type: "string" },
        },
      },
    },
  },
} as const;

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** 构建 chat completions 请求体（纯函数）：始终 stream，reasoning_effort 为空则省略，enable_thinking 未设置则省略 */
export function buildChatBody(input: {
  model: string;
  maxTokens: number;
  reasoningEffort: string;
  enableThinking?: boolean;
  messages: ChatMessage[];
  responseFormat?: Record<string, unknown>;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    temperature: 0,
    max_tokens: input.maxTokens,
    messages: input.messages,
    stream: true,
  };
  if (input.reasoningEffort) {
    body.reasoning_effort = input.reasoningEffort;
  }
  if (input.enableThinking !== undefined) {
    body.enable_thinking = input.enableThinking;
  }
  if (input.responseFormat) {
    body.response_format = input.responseFormat;
  }
  return body;
}

/**
 * 解析整段 SSE 文本（流式响应的全部 chunk 拼接后调用）：
 * 只累计 choices[0].delta.content（忽略 delta.reasoning 思考文本），遇 [DONE] 结束，
 * error 载荷提取为 error 字段。兼容少数服务最终块用 message.content 而非 delta 的写法。
 */
export function collectSseContent(sseText: string): {
  content: string;
  done: boolean;
  error: string | null;
} {
  let content = "";
  let done = false;
  let error: string | null = null;
  for (const rawLine of sseText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) {
      continue; // 注释(: keepalive)、event/id 行等
    }
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") {
      done = true;
      break;
    }
    let json: any;
    try {
      json = JSON.parse(payload);
    } catch {
      continue;
    }
    if (json?.error) {
      error =
        typeof json.error === "string"
          ? json.error
          : String(json.error?.message ?? JSON.stringify(json.error));
      break;
    }
    const choice = json?.choices?.[0];
    const piece = choice?.delta?.content ?? choice?.message?.content;
    if (typeof piece === "string") {
      content += piece;
    }
  }
  return { content, done, error };
}

export type LlmFailureKind = "timeout" | "unreachable" | "network" | "moderation" | "other";

/**
 * 沿 error.cause 链归类网络级失败（纯函数）：
 * undici 的 Headers/BodyTimeoutError、AbortSignal 的 TimeoutError -> timeout；
 * ECONNREFUSED/ENOTFOUND -> unreachable；其它 fetch failed 类 -> network；
 * 云端内容审核拦截（DashScope "inappropriate content" / DataInspectionFailed，
 * 来自 SSE error 载荷或 HTTP 400 载荷）-> moderation（重试/降级均无效，须快速失败）；
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
  if (/headertimeout|bodytimeout|timeouterror|timed out/.test(blob)) {
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

async function chatCompletion(
  messages: ChatMessage[],
  responseFormat: Record<string, unknown> | undefined,
  model: string,
): Promise<string> {
  const body = buildChatBody({
    model,
    maxTokens: config.llmMaxTokens,
    reasoningEffort: config.llmReasoningEffort,
    enableThinking: config.llmEnableThinking,
    messages,
    responseFormat,
  });

  const res = await fetch(`${config.llmBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.llmApiKey ? { authorization: `Bearer ${config.llmApiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20 * 60 * 1000),
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 500);
    const err = new Error(`LLM HTTP ${res.status}: ${detail}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }

  // 流式：响应头即时到达 + 数据持续流动，避开 undici 默认 300s 的 headers/body 超时；
  // 服务端忽略 stream 参数返回普通 JSON 时按非流式读取（content-type 分流）
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    if (!res.body) {
      throw new Error("LLM 流式响应无 body");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sseText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      sseText += decoder.decode(value, { stream: true });
    }
    sseText += decoder.decode();
    const { content, done, error } = collectSseContent(sseText);
    if (error) {
      throw new Error(`LLM 流式生成中断: ${error}`);
    }
    if (!content) {
      throw new Error(
        `LLM 返回内容为空(SSE ${sseText.length}B, done=${done}): ${sseText.slice(0, 200)}`,
      );
    }
    if (!done) {
      console.warn(`[llm] 警告：SSE 流未以 [DONE] 结束，按已收到的 ${content.length} 字符采信`);
    }
    return content;
  }

  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = json?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`LLM 返回内容为空: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return content;
}

/**
 * DashScope 等 OpenAI 兼容服务在 response_format 为 json_object 时校验 messages 必须含
 * "json" 一词。提示词已精简（结构约束由代码承担，不再写 "输出 JSON"），因此 json_object
 * 降级分支由本函数补一条含关键词的 user 消息；json_schema 与纯文本分支不动 messages。
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

/**
 * 调 LLM 并校验结构。优先 strict json_schema（schema 可传入，默认课程组装链）；
 * 服务端不支持时逐级降级：json_object -> 纯文本（配合括号配对提取）。
 * 云端内容审核拦截（moderation）不属端点能力问题，降级重试无意义，立即失败。
 */
export async function callLlmJson(
  messages: ChatMessage[],
  schema: Record<string, unknown> = courseJsonSchema,
  model: string = config.llmModel,
): Promise<unknown> {
  const formats: Array<Record<string, unknown> | undefined> = [
    {
      type: "json_schema",
      json_schema: { name: "structured_output", strict: true, schema },
    },
    { type: "json_object" },
    undefined,
  ];

  let lastError: unknown;
  for (const format of formats) {
    try {
      const content = await chatCompletion(
        messagesWithJsonKeyword(messages, format),
        format,
        model,
      );
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
        `[llm] 请求方式失败，降级重试: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`,
      );
    }
  }
  throw new Error(`[llm] 结构化输出失败（已尝试全部降级方式）: ${(lastError as Error)?.message}`);
}

/**
 * 并发上限内对每个句子执行 worker，结果按输入顺序返回。
 * 任一 worker 抛错即整体 reject（用于"某句最终失败 -> 整体中止"），并停止派发后续任务。
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const size = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: size }, async () => {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  });
  await Promise.all(runners);
  return results;
}

/** 归一化为可逐字比对的词序列（小写、去标点），与 align 的口径一致 */
function tokenSequence(text: string): string {
  return text.split(/\s+/).map(normalizeToken).filter(Boolean).join(" ");
}

/**
 * 组装链里是否存在逐字等于原句完整形式的一行（仅大小写/标点差异）。
 * 这是"模型没有把这一句丢弃或改写"的硬性校验：缩写被展开、漏词、换词都会失配。
 */
export function containsFullSentence(statements: DraftStatement[], sentence: string): boolean {
  const target = tokenSequence(sentence);
  if (!target) return false;
  return statements.some((s) => tokenSequence(s.english) === target);
}

/** 单句组装链失败时的最大尝试次数（含首次） */
const LLM_ATTEMPTS_PER_SENTENCE = 2;

/** 单句：调用 LLM + 结构校验 + 完整原句锚点校验，产出一条 statement 组装链 */
async function generateChainForSentence(
  sentence: string,
  label: string,
  note: string | undefined,
): Promise<DraftStatement[]> {
  const raw = await callLlmJson(buildMessages(sentence, note) as ChatMessage[]);
  const parsed = draftSchema.safeParse(coerceCourseOutput(raw));
  if (!parsed.success) {
    throw new Error(
      `[llm] 输出结构校验失败（${label}）：${parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  const { changes, emptyIndexes } = normalizeStatementsEnglish(parsed.data.statements);
  if (changes.length > 0) {
    console.log(
      `[llm] english 标点清理（${label}，共 ${changes.length} 行，撇号/连字符保留）:\n  ${changes
        .slice(0, 5)
        .join("\n  ")}`,
    );
  }
  if (emptyIndexes.length > 0) {
    throw new Error(
      `[llm] 输出结构校验失败（${label}）：第 ${emptyIndexes.join(", ")} 行 english 去掉标点后为空`,
    );
  }
  if (!containsFullSentence(parsed.data.statements, sentence)) {
    throw new Error(
      `[llm] 完整原句缺失（${label}）：输出里没有逐字等于「${sentence}」的行（可能被丢弃、漏词或把缩写展开如 don't→do not）`,
    );
  }
  return parsed.data.statements;
}

/**
 * 生成课程包内唯一的课程：一句一调用，多个句子并发处理（并发数 config.llmConcurrency）。
 * 预处理已把转写拆成完整句（一个 segment 即一句），这里直接逐句生成组装链，
 * 按原句顺序拼接成单一课程；标题用课程包标题。
 * 任一句子在重试后仍失败（结构不合法 / 完整原句缺失）则整体中止抛错——绝不让某一句被悄悄丢弃。
 */
export async function generateDraft(
  transcript: Transcript,
  packTitle: string,
): Promise<DraftCourse> {
  const sentences = transcript.segments.map((seg) => seg.text.trim()).filter(Boolean);
  const limit = config.llmConcurrency;
  console.log(
    `[llm] ${sentences.length} 个句子，一句一调用，并发 ${limit}（模型 ${config.llmModel}）...`,
  );

  const chains = await mapWithConcurrency(sentences, limit, async (sentence, index) => {
    const label = `句 ${index + 1}/${sentences.length}`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= LLM_ATTEMPTS_PER_SENTENCE; attempt++) {
      try {
        const note =
          attempt > 1
            ? `上一次输出不合格：${(lastError as Error).message}。请修正上述问题重新输出，并确保有一行 english 恰好是这句的全部词（保留缩写、不增删换词）：${sentence}`
            : undefined;
        const chain = await generateChainForSentence(sentence, label, note);
        if (index === 0 || (index + 1) % 10 === 0) {
          console.log(`[llm] ${label} 完成（${chain.length} 行）`);
        }
        return chain;
      } catch (error) {
        lastError = error;
        if (attempt < LLM_ATTEMPTS_PER_SENTENCE) {
          console.warn(`[llm] ${label} 失败，重试一次：${(error as Error).message}`);
        }
      }
    }
    throw new Error(
      `[llm] ${label} 最终失败（已尝试 ${LLM_ATTEMPTS_PER_SENTENCE} 次）：${(lastError as Error).message}`,
    );
  });

  const statements = chains.flat();
  return { title: packTitle, description: "", statements };
}

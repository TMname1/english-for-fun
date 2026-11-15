import { z } from "zod";

import type { DraftCourse, DraftStatement, Transcript, TranscriptSegment } from "./types";
import { config } from "./config";
import { buildMessages } from "./prompt";

/**
 * LLM 输出的代码侧约束（不依赖提示词），按顺序四层：
 * 1. response_format：请求携带 json_schema（strict），字段名/必填/类型由服务端保证；
 *    服务端不支持时逐级降级 json_object -> 纯文本 + 括号配对提取（callLlmJson）。
 * 2. zod 结构校验（draftSchema）：兜底降级模式，并清洗 {"courses":[...]} 旧包裹。
 * 3. english 标点清理（normalizeStatementsEnglish）：见下方说明。
 * 4. 课程质量校验（evaluateCourseQuality）：组装链形态劣化时带问题说明重试。
 */
export const draftSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
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

/** 结构化输出的 JSON Schema（strict 风格：全字段 required，可选用空串表达）；顶层是单个课程对象，一次调用生成一门课 */
export const courseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "description", "statements"],
  properties: {
    title: { type: "string" },
    description: { type: "string" },
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
): Promise<string> {
  const body = buildChatBody({
    model: config.llmModel,
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
 * 调 LLM 并校验结构。优先 strict json_schema；服务端不支持时逐级降级：
 * json_object -> 纯文本（配合括号配对提取）。
 * 云端内容审核拦截（moderation）不属端点能力问题，降级重试无意义，立即失败。
 */
export async function callLlmJson(messages: ChatMessage[]): Promise<unknown> {
  const formats: Array<Record<string, unknown> | undefined> = [
    {
      type: "json_schema",
      json_schema: { name: "course_pack", strict: true, schema: courseJsonSchema },
    },
    { type: "json_object" },
    undefined,
  ];

  let lastError: unknown;
  for (const format of formats) {
    try {
      const content = await chatCompletion(messagesWithJsonKeyword(messages, format), format);
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
          `[llm] 无法连接 ${config.llmBaseUrl}。请确认服务已启动（Ollama 桌面托盘版会自动拉起服务，无需手动 \`ollama serve\`；纯命令行安装才需要）且模型已 \`ollama pull ${config.llmModel}\`。错误链: ${detail}`,
        );
      }
      if (kind === "network") {
        throw new Error(
          `[llm] 与 ${config.llmBaseUrl} 的连接被中断（服务端进程可能崩溃/重启）。错误链: ${detail}`,
        );
      }
      if (kind === "moderation") {
        throw new Error(
          `[llm] 云端内容审核拦截：${config.llmBaseUrl} 判定 ${config.llmModel} 的输出不合规并中断生成。` +
            `这是云端安全策略而非调用方式问题，重试/降级无效——可改用本地 ollama 端点重跑该分块，` +
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

/** 把转写段落按累计词数分成多块，长音频逐块调用 LLM */
export function chunkTranscript(transcript: Transcript, maxWords: number): Transcript[] {
  const chunks: Transcript[] = [];
  let current: Transcript["segments"] = [];
  let words = 0;

  const flush = () => {
    if (current.length > 0) {
      chunks.push({ ...transcript, segments: current });
      current = [];
      words = 0;
    }
  };

  for (const seg of transcript.segments) {
    const segWords = (seg.words?.length ?? 0) || seg.text.split(/\s+/).filter(Boolean).length;
    if (words + segWords > maxWords && current.length > 0) {
      flush();
    }
    current.push(seg);
    words += segWords;
  }
  flush();
  return chunks;
}

/** 句末判定：以 . ! ? 结尾（允许可见引号/括号收尾） */
const SENTENCE_END = /[.!?]["'”’)\]]*$/;

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * 把 whisper 的断句碎片（词级时间戳切段导致句子被拦腰截断）拼回完整句：
 * 累积到句末标点才成句。不再按词数强制断开，长难句（含多个从句、只在末尾有句号）
 * 会作为完整一句保留下来。
 * 返回仍复用 TranscriptSegment（id/start 取该句第一个碎片，end 取收尾碎片），
 * 可直接进 chunkTranscript / formatTranscript。
 */
export function mergeSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  const sentences: TranscriptSegment[] = [];
  let pending = "";
  let pendingId = 0;
  let pendingStart = 0;
  let pendingEnd = 0;
  let pendingClip: number | undefined;

  const push = (text: string, end: number): void => {
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (!trimmed) return;
    sentences.push({ id: pendingId, start: pendingStart, end, text: trimmed });
  };

  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;
    // clip 边界强制断句：跨 clip 拼句会产出跨越未选区间的 statement，播放时漏出未选内容
    if (pending && seg.clipIndex !== pendingClip) {
      push(pending, pendingEnd);
      pending = "";
    }
    if (!pending) {
      pendingId = seg.id;
      pendingStart = seg.start;
      pendingClip = seg.clipIndex;
    }
    pending = pending ? `${pending} ${text}` : text;
    pendingEnd = seg.end;

    if (SENTENCE_END.test(pending)) {
      push(pending, seg.end);
      pending = "";
      continue;
    }
  }
  if (pending) {
    push(pending, pendingEnd);
  }
  return sentences;
}

/** 质量判定阈值（见 evaluateCourseQuality） */
export const QUALITY_COMBO_RATIO = 0.25;
export const QUALITY_LONG_WORDS = 5;

/**
 * 课程质量校验（纯函数）：针对小模型两类劣化签名——
 * 1. 单词课：≥3 词的行占比不足 25%（只列碎片、没有组装链）；
 * 2. 句子太少：≥5 词的行数 < min(3, ⌈句数/2⌉)（几乎没走到完整句）。
 * 不再限制单行长度——长难句是有意保留的教学内容。
 * sentenceCount 为该分块预拼后的完整句数。
 */
export function evaluateCourseQuality(
  course: DraftCourse,
  sentenceCount: number,
): { ok: true } | { ok: false; problems: string[] } {
  const counts = course.statements.map((s) => countWords(s.english));
  if (counts.length === 0) {
    return { ok: false, problems: ["课程没有任何 statement"] };
  }
  const problems: string[] = [];

  const combo = counts.filter((n) => n >= 3).length;
  if (combo < counts.length * QUALITY_COMBO_RATIO) {
    problems.push(
      `疑似单词列表课：仅 ${combo}/${counts.length} 行达到 ≥3 词（占比不足 25%），必须给出「单词→短语→整句」逐级组装链`,
    );
  }
  const longRows = counts.filter((n) => n >= QUALITY_LONG_WORDS).length;
  const needLong = Math.min(3, Math.ceil(sentenceCount / 2));
  if (longRows < needLong) {
    problems.push(
      `完整句太少：仅 ${longRows} 行达到 ≥${QUALITY_LONG_WORDS} 词，本部分 ${sentenceCount} 个句子至少需要 ${needLong} 行`,
    );
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true };
}

/** 单分块：调用 LLM + 结构校验，产出 DraftCourse */
async function generateCourseForChunk(
  chunk: Transcript,
  type: "dialogue" | "music",
  packTitle: string,
  note: string | undefined,
  label: string,
): Promise<DraftCourse> {
  const raw = await callLlmJson(buildMessages(chunk, type, packTitle, note) as ChatMessage[]);
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
  return parsed.data;
}

/**
 * 生成课程包内唯一的课程：
 * 长音频仍按词数分块逐块调 LLM（每块产出一份 statement 链），最后按块序合并成单一课程；
 * title/description 取第一块。"分课程"功能已删除，不再产出 courses 数组。
 */
export async function generateDraft(
  transcript: Transcript,
  type: "dialogue" | "music",
  packTitle: string,
): Promise<DraftCourse> {
  const merged = mergeSegments(transcript.segments);
  if (merged.length !== transcript.segments.length) {
    console.log(
      `[llm] 句子预拼：${transcript.segments.length} 个转写碎片 -> ${merged.length} 个完整句`,
    );
  }
  const chunks = chunkTranscript({ ...transcript, segments: merged }, config.llmMaxWordsPerCall);
  const statements: DraftCourse["statements"] = [];
  let firstCourse: DraftCourse | undefined;

  for (const [index, chunk] of chunks.entries()) {
    const label = chunks.length > 1 ? `分块 ${index + 1}/${chunks.length}` : "整段";
    const baseNote =
      chunks.length > 1
        ? `注意：这是整段音频的第 ${index + 1}/${chunks.length} 部分，请只为这部分生成 statement 链（最终会与其他部分合并成一门课程）。`
        : undefined;
    console.log(`[llm] 结构化分析 ${label}（模型 ${config.llmModel}）...`);
    const sentenceCount = chunk.segments.length;

    let course = await generateCourseForChunk(chunk, type, packTitle, baseNote, label);
    let verdict = evaluateCourseQuality(course, sentenceCount);
    if (!verdict.ok) {
      console.warn(`[llm] 课程质量不达标（${label}）：${verdict.problems.join("；")}，重试一次`);
      const correction =
        `上一次输出不合格：${verdict.problems.join("；")}。` +
        `请重做：本部分共 ${sentenceCount} 个完整句，每个目标句都要从碎片逐级组装出完整句行，` +
        `覆盖所有有教学价值的句子；不要只列单词碎片。`;
      const note = baseNote ? `${baseNote}\n${correction}` : correction;
      course = await generateCourseForChunk(chunk, type, packTitle, note, label);
      verdict = evaluateCourseQuality(course, sentenceCount);
      if (!verdict.ok) {
        throw new Error(
          `[llm] 课程质量仍不达标（${label}，已重试 1 次）：${verdict.problems.join("；")}`,
        );
      }
    }
    firstCourse ??= course;
    statements.push(...course.statements);
  }

  return {
    // 多块合并后"第 X 部分"式的课内标题已失真，直接用课程包标题
    title: chunks.length > 1 ? packTitle : firstCourse?.title ?? packTitle,
    description: firstCourse?.description,
    statements,
  };
}

import { z } from "zod";

import type { ChatMessage } from "./llm-client";
import type {
  DraftChain,
  DraftStatement,
  SentenceAttempt,
  SentenceFailure,
  StatementSpan,
  Transcript,
} from "./types";
import { config } from "./config";
import { callLlmJson } from "./llm-client";
import { buildMessages, loadSentencePrompt } from "./prompt";
import { withPrompt } from "./prompt-store";
import { buildTokenUniverse, sentenceWordView } from "./words";

// 传输层（ChatOpenAI + 三级降级 + 失败分类）已迁到 llm-client；这里再导出，
// 保持既有调用方与单测的 import 路径不变。
export {
  buildModelKwargs,
  callLlmJson,
  classifyLlmFailure,
  courseJsonSchema,
  extractJsonObject,
  messagesWithJsonKeyword,
} from "./llm-client";
export type { ChatMessage, LlmFailureKind } from "./llm-client";

/**
 * LLM 输出的代码侧约束（不依赖提示词），按顺序：
 * 1. response_format：请求携带 json_schema（strict），字段名/必填/类型由服务端保证；
 *    服务端不支持时逐级降级 json_object -> 纯文本 + 括号配对提取（callLlmJson）。
 * 2. zod 结构校验（draftRowsSchema）：兜底降级模式，并清洗 {"courses":[...]} 旧包裹。
 * 3. 词编号校验（validateRowIndexes）：升序连续、不越界、不得逐词成行，且必须有一行覆盖整句。
 * 4. 单词行的自动补救（autoStripSingleWordRows）：只要校验失败、而该次输出里混着单词成行的行，
 *    就本地删掉这些单词行、剩余行重新校验；合格就当作该句的组装链，不合格才记为失败交给用户选择。
 *    与失败原因无关（越界、跳号、缺整句行等同样先删一遍），输出里没有单词行时不做任何处理。
 * 5. english 由编号还原（cleanWordToken 逐词去标点）：模型从不书写英文，
 *    因此 $10,000 / don't / U.S. / 弯引号这类改写不可能发生。
 *
 * 一次调用只处理一个句子（一句一调用，多句并发），因此输出就是一条 statement 组装链。
 * 校验失败**不自动重试**（只有上面第 4 条那种不调模型的本地补救）：一次不合格就直接
 * 落进失败清单，由用户在 GUI 里决定「重试该句 / 删除该句」。
 */
export interface DraftRow {
  indexes: number[];
  chinese: string;
  phonetic?: string;
}

export const draftRowsSchema = z.object({
  statements: z
    .array(
      z.object({
        indexes: z.array(z.number().int().nonnegative()).min(1),
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
 * 逐词还原 english：只允许字母、数字、撇号、连字符，其余字符**删除**（不替换为空格）。
 * 与 align 的 normalizeToken 口径一致，且不会把一个词拆成两个 token——
 * 这正是 "$10,000" 不会再变成 "10 000" 的原因；撇号/连字符保留（don't / t-shirt）。
 * chinese 不做清理：中文语义依赖标点（；、。（）），由模型输出直接采信。
 */
const NON_WORD_CHARS = /[^\p{L}\p{N}'’-]/gu;

export function cleanWordToken(raw: string): string {
  return raw.replace(NON_WORD_CHARS, "");
}

/** 按编号拼回 english；token 数与编号数严格 1:1（词表已过滤纯标点词） */
export function buildEnglishFromIndexes(indexes: number[], words: string[]): string {
  return indexes
    .map((i) => cleanWordToken(words[i] ?? ""))
    .filter(Boolean)
    .join(" ");
}

/**
 * 「逐词成行」这条校验失败的固定标识（validateRowIndexes 的文案里带它）。
 * 单独抽成常量，避免文案改动后「这是单词行问题」这个语义悄悄失效
 * （自动删单词行的判定不依赖文案，见 autoStripSingleWordRows）。
 */
export const SINGLE_WORD_ROW_MARKER = "属于逐词成行";

/**
 * 校验模型给出的行编号：每行非空、整数、在 0..N-1 内、行内升序连续、
 * 不得逐词成行（每行至少 2 个词；本句只有 1 个词时整句行本身就是 [0]，放行），
 * 且必须有一行恰好覆盖整句 0..N-1（连续 ⇒ 覆盖即等价）。
 * 返回中文原因（直接进 needs_fix 界面），合法返回 null。
 */
export function validateRowIndexes(rows: number[][], wordCount: number): string | null {
  if (wordCount <= 0) {
    return "本句没有可用的词，无法生成";
  }
  let hasFull = false;
  let singleWordRow = -1;
  for (const [r, row] of rows.entries()) {
    if (!row || row.length === 0) {
      return `第 ${r + 1} 行没有任何词编号`;
    }
    for (const [k, v] of row.entries()) {
      if (!Number.isInteger(v) || v < 0 || v >= wordCount) {
        return `第 ${r + 1} 行的编号 ${v} 越界（本句编号范围 0..${wordCount - 1}，编号从 0 开始）`;
      }
      if (k > 0 && v !== row[k - 1] + 1) {
        return `第 ${r + 1} 行的编号必须升序连续（${row[k - 1]} 之后应为 ${row[k - 1] + 1}，实际是 ${v}）`;
      }
    }
    // 单词成行：越界/连续性检查之后才判，保证越界文案优先（错误原因更精确）
    if (wordCount > 1 && row.length === 1 && singleWordRow < 0) {
      singleWordRow = r;
    }
    if (row.length === wordCount && row[0] === 0) {
      hasFull = true;
    }
  }
  if (singleWordRow >= 0) {
    return `第 ${singleWordRow + 1} 行只有一个词（编号 ${rows[singleWordRow][0]}），${SINGLE_WORD_ROW_MARKER}；每行至少 2 个词，请按短语或从句片段切分`;
  }
  if (!hasFull) {
    return `没有任何一行恰好覆盖本句全部 ${wordCount} 个词（应有一行编号恰为 0,1,…,${wordCount - 1}）`;
  }
  return null;
}

/** 把模型的行编号映射为 statement（english 由编号还原）；越界行跳过，仅供失败快照展示 */
export function rowsToStatements(rows: DraftRow[], words: string[]): DraftStatement[] {
  return rows
    .filter(
      (row) =>
        Array.isArray(row.indexes) &&
        row.indexes.length > 0 &&
        row.indexes.every((i) => Number.isInteger(i) && i >= 0 && i < words.length),
    )
    .map((row) => {
      const statement: DraftStatement = {
        english: buildEnglishFromIndexes(row.indexes, words),
        chinese: row.chinese,
      };
      if (row.phonetic !== undefined) {
        statement.phonetic = row.phonetic;
      }
      return statement;
    })
    .filter((s) => s.english.length > 0);
}

/**
 * 从失败快照的 raw（模型上一次的原始输出，字符串）里恢复行编号输出。
 * 解析失败 / 结构不合规 / statements 为空一律返回 null——调用方据此判定「无法按编号处理」。
 */
export function parseDraftRowsFromRaw(raw: string | null | undefined): DraftRow[] | null {
  if (!raw) return null;
  try {
    const parsed = draftRowsSchema.safeParse(coerceCourseOutput(JSON.parse(raw)));
    // api 的 strictNullChecks=false 会让 zod 把必填字段推断成可选；运行时已由 safeParse 校验
    return parsed.success ? (parsed.data.statements as DraftRow[]) : null;
  } catch {
    return null;
  }
}

/** 「删除单词行」的结果：合格时给可用组装链，不合格时给中文原因（直接进 needs_fix 界面） */
export interface StripWordsResult {
  /** 被删掉的单词行数 */
  removed: number;
  /** 剩余输出可用的组装链（含词区间）；null 表示仍不合规，原因见 reason */
  chain: { statements: DraftStatement[]; spans: StatementSpan[] } | null;
  reason: string | null;
  /** 剩余行还原出的 statement（供失败快照展示；解析不出行时为 null） */
  statements: DraftStatement[] | null;
  raw: string | null;
}

/**
 * 删除单词行：把这次输出里单词成行的行（N>1 时 indexes 只有 1 个词）全部丢掉，
 * 剩余行按同一套规则重新校验——合格即作为该句的组装链（english 由编号还原、词区间直接算），
 * 不合格则返回原因。自动补救（autoStripSingleWordRows）与 resolve 续跑都走这里。
 * 本句只有 1 个词时整句行本身就是 [0]，不算单词成行，不会被删。
 */
export function stripSingleWordRows(
  rawInput: string | null | undefined,
  wordStart: number,
  words: string[],
): StripWordsResult {
  const raw = rawInput ?? null;
  const rows = parseDraftRowsFromRaw(raw);
  if (!rows) {
    return {
      removed: 0,
      chain: null,
      reason:
        "上次输出里解析不出词编号（不是合法的 indexes 结构），无法删除单词行；请改用「重试该句」或「删除该句」",
      statements: null,
      raw,
    };
  }
  const wordCount = words.length;
  const kept = rows.filter((r) => !(wordCount > 1 && r.indexes.length === 1));
  const removed = rows.length - kept.length;
  const statements = rowsToStatements(kept, words);
  if (removed === 0) {
    return {
      removed,
      chain: null,
      reason: "上次输出里没有单词成行的行，无需删除；请改用「重试该句」或「删除该句」",
      statements,
      raw,
    };
  }
  const invalid = validateRowIndexes(
    kept.map((r) => r.indexes),
    wordCount,
  );
  if (invalid) {
    return {
      removed,
      chain: null,
      reason: `已删除 ${removed} 个单词行，但剩余 ${kept.length} 行仍不合规：${invalid}`,
      statements,
      raw,
    };
  }
  if (statements.length !== kept.length) {
    return {
      removed,
      chain: null,
      reason: `已删除 ${removed} 个单词行，但剩余行里有 ${kept.length - statements.length} 行还原不出 english`,
      statements,
      raw,
    };
  }
  const spans: StatementSpan[] = kept.map((r) => ({
    wordStart: wordStart + r.indexes[0],
    wordEnd: wordStart + r.indexes[r.indexes.length - 1] + 1,
  }));
  return { removed, chain: { statements, spans }, reason: null, statements, raw };
}

/** 自动补救结果：chain 合格可直接用；不合格时 attempt 是追加给用户看的失败快照 */
export interface AutoStripOutcome {
  /** 被自动删掉的单词行数（> 0 才会返回本结构） */
  removed: number;
  chain: { statements: DraftStatement[]; spans: StatementSpan[] } | null;
  attempt: SentenceAttempt | null;
}

/**
 * 单词行的自动补救（不调模型、不重试）：
 * **只看输出、不看失败原因**——只要模型这一次输出里混着单词成行的行（本句词数 > 1 时
 * indexes 只有 1 个词），就本地删掉这些行、剩余行按同一套规则重新校验：
 * 合格就直接作为该句的组装链（静默通过，只写日志）；仍不合格则生成一条带 autoStrip 标记的
 * 失败快照，交给用户在 GUI 里选择「重试该句 / 删除该句」。
 *
 * 为什么不再按失败原因判断：越界、跳号、缺整句行等失败同样经常伴随单词行，
 * 以前这类句子只能靠用户手点「删除所有单个单词」在本地救回，现在一律自动做一遍。
 * 输出里没有单词行（含解析不出编号）时返回 null，保持原失败原因不变。
 */
export function autoStripSingleWordRows(
  rawInput: string | null | undefined,
  wordStart: number,
  words: string[],
): AutoStripOutcome | null {
  const result = stripSingleWordRows(rawInput, wordStart, words);
  if (result.chain && result.reason === null) {
    return { removed: result.removed, chain: result.chain, attempt: null };
  }
  // 没有删掉任何行 ⇒ 这次输出本来就不含单词行，或解析不出编号：不动，保留原失败原因
  if (result.removed === 0) return null;
  return {
    removed: result.removed,
    chain: null,
    attempt: {
      reason: `已自动删除 ${result.removed} 个单词行，仍不合规：${result.reason ?? "未知原因"}`,
      statements: result.statements,
      raw: result.raw,
      autoStrip: true,
    },
  };
}

/** 结构化输出的 JSON Schema（strict 风格：全字段 required，可选用空串表达） */
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

/** 把未知结构安全转为字符串，用于失败快照里的 raw 展示 */
function stringifyUnknown(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * 单句「内容校验」失败（可恢复）：结构不合法 / 词编号不合法 / english 还原为空。
 * 与网络、超时、审核等致命错误区分开；调用方据此收集为可人工处理的失败项，
 * 而非让整条流水线直接中止。
 */
export class SentenceContentError extends Error {
  constructor(
    message: string,
    readonly statements?: DraftStatement[],
    readonly raw?: unknown,
  ) {
    super(message);
    this.name = "SentenceContentError";
  }
}

/** 单句：调用 LLM + 结构校验 + 词编号校验，产出一条 statement 组装链与其词区间 */
async function generateChainForSentence(
  words: string[],
  wordStart: number,
  label: string,
): Promise<{ statements: DraftStatement[]; spans: StatementSpan[] }> {
  // 提示词从 Langfuse Prompt Management 取（带缓存 + 本地兜底），并把版本关联到本次 trace
  const prompt = await loadSentencePrompt();
  const raw = await withPrompt(prompt, () =>
    callLlmJson(buildMessages(words, prompt.text) as ChatMessage[]),
  );
  const parsed = draftRowsSchema.safeParse(coerceCourseOutput(raw));
  if (!parsed.success) {
    throw new SentenceContentError(
      `[llm] 输出结构校验失败（${label}）：${parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
      undefined,
      raw,
    );
  }
  // api 的 strictNullChecks=false 会让 zod 把必填字段推断成可选；运行时已由 safeParse 校验
  const rows = parsed.data.statements as DraftRow[];
  const invalid = validateRowIndexes(
    rows.map((r) => r.indexes),
    words.length,
  );
  if (invalid) {
    throw new SentenceContentError(
      `[llm] 词编号不合法（${label}）：${invalid}`,
      rowsToStatements(rows, words),
      raw,
    );
  }
  const statements = rowsToStatements(rows, words);
  if (statements.length !== rows.length) {
    throw new SentenceContentError(
      `[llm] 词编号还原失败（${label}）：有 ${rows.length - statements.length} 行还原出的 english 为空`,
      statements,
      raw,
    );
  }
  const spans: StatementSpan[] = rows.map((r) => ({
    wordStart: wordStart + r.indexes[0],
    wordEnd: wordStart + r.indexes[r.indexes.length - 1] + 1,
  }));
  return { statements, spans };
}

type SentenceOutcome =
  | { kind: "chain"; index: number; statements: DraftStatement[]; spans: StatementSpan[] }
  | { kind: "failure"; index: number; failure: SentenceFailure }
  | { kind: "empty"; index: number };

/**
 * 结构化收集模式：逐句生成（一句只调一次模型，校验失败**不自动重试**），
 * 失败项收集为失败清单，由用户在 needs_fix 界面决定「重试该句 / 删除该句」。
 * 唯一例外是「输出里混着单词行」：本地删掉单词行后重新校验，合格即通过（不调模型），
 * 仍不合格才进入失败清单（见 autoStripSingleWordRows）。
 * 致命错误（网络/超时/审核等）仍直接抛出。
 * 按 transcript.segments 的原数组下标迭代（不过滤空句），保证 index 与段落一一对应。
 */
export async function generateDraftCollected(
  transcript: Transcript,
  onlyIndexes?: number[],
): Promise<{
  chains: DraftChain[];
  failures: SentenceFailure[];
}> {
  const universe = buildTokenUniverse(transcript);
  const total = transcript.segments.length;
  const targetSet = new Set(onlyIndexes ?? transcript.segments.map((_, i) => i));
  const jobs = transcript.segments
    .map((seg, index) => ({
      index,
      sentence: seg.text.trim(),
      view: sentenceWordView(universe, index),
    }))
    .filter((j) => targetSet.has(j.index));

  const limit = config.llmConcurrency;
  console.log(
    `[llm] 收集模式：${jobs.length} 个句子，一句一调用，并发 ${limit}（模型 ${config.llmModel}）...`,
  );

  const results = await mapWithConcurrency(jobs, limit, async (job): Promise<SentenceOutcome> => {
    const label = `句 ${job.index + 1}/${total}`;
    if (!job.sentence || !job.view || job.view.words.length === 0) {
      return { kind: "empty", index: job.index };
    }
    const words = job.view.words;
    if (words.length > 60) {
      console.warn(
        `[llm] ${label} 有 ${words.length} 个词（疑似段级降级的长段），编号输出较长，失败可考虑换更强模型`,
      );
    }
    try {
      const chain = await generateChainForSentence(words, job.view.wordStart, label);
      if (job.index === 0 || (job.index + 1) % 10 === 0) {
        console.log(`[llm] ${label} 完成（${chain.statements.length} 行）`);
      }
      return {
        kind: "chain",
        index: job.index,
        statements: chain.statements,
        spans: chain.spans,
      };
    } catch (error) {
      if (!(error instanceof SentenceContentError)) {
        throw error;
      }
      const raw = error.raw != null ? stringifyUnknown(error.raw) : null;
      const attempts: SentenceAttempt[] = [
        { reason: error.message, statements: error.statements ?? null, raw },
      ];
      // 只要输出里混着单词行：本地删掉后重新校验，合格就直接用（不调模型、不重试）
      const auto = autoStripSingleWordRows(raw, job.view.wordStart, words);
      if (auto?.chain) {
        console.log(
          `[llm] ${label} 输出混着 ${auto.removed} 个单词行，已自动删除后通过（${auto.chain.statements.length} 行）`,
        );
        return {
          kind: "chain",
          index: job.index,
          statements: auto.chain.statements,
          spans: auto.chain.spans,
        };
      }
      if (auto?.attempt) {
        console.warn(
          `[llm] ${label} 自动删除单词行后仍不合规，交给用户处理：${auto.attempt.reason}`,
        );
        attempts.push(auto.attempt);
      } else {
        console.warn(`[llm] ${label} 未通过校验（不自动重试）：${error.message}`);
      }
      return {
        kind: "failure",
        index: job.index,
        failure: { index: job.index, sentence: job.sentence, attempts },
      };
    }
  });

  const chains: DraftChain[] = [];
  const failures: SentenceFailure[] = [];
  for (const r of results) {
    if (r.kind === "chain") {
      chains.push({ index: r.index, statements: r.statements, spans: r.spans });
    } else if (r.kind === "failure") {
      failures.push(r.failure);
    }
  }
  return { chains, failures };
}

/**
 * CLI/本地严格路径：任一句失败即整体抛错（兼容 forgeMake）。
 * 不做重试（与 GUI 收集模式一致；唯一例外是「输出里混着单词行」的本地删单词补救）。
 * 仅线上 GUI（pipeline-runner）走 generateDraftCollected 做可恢复处理。
 */
export async function generateDraft(transcript: Transcript): Promise<DraftChain[]> {
  const { chains, failures } = await generateDraftCollected(transcript);
  if (failures.length > 0) {
    const first = failures[0];
    const last = first.attempts[first.attempts.length - 1];
    throw new Error(
      `[llm] 句 ${first.index + 1}/${transcript.segments.length} 未通过校验（不自动重试）：${last?.reason ?? "未知原因"}`,
    );
  }
  return chains;
}

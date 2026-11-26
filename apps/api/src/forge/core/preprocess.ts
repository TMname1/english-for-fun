import { z } from "zod";

import type { AsrSegmentParts, AsrWordInfo, QwenAsrSentence } from "./asr";
import type { ManagedPrompt, PromptVars } from "./prompt-store";
import type { Transcript, TranscriptSegment, TranscriptWord } from "./types";
import { asrSegmentParts } from "./asr";
import { config } from "./config";
import { callLlmJson, mapWithConcurrency } from "./llm";
import { compilePrompt, getManagedPrompt, PROMPT_EMPTY, withPrompt } from "./prompt-store";

/**
 * 预处理：ASR 同步返回整段 text + 碎片词表（一个词可能被拦腰拆成 "Genu"+"inely"、
 * "I"+"'"+"ve"）。LLM 按语义理解把词序号划分成完整句子（不局限于标点），并顺手给出
 * 每句的完整中文——这一步手上有整段英文全文，比结构阶段只看词表译得准。
 * 代码按分组确定性地合并碎片词、从原始 ASR 词取时间戳——时间戳零幻觉。
 * 输出契约与下游一致：一个 segment 即一个完整句，text = words.join(" ")，chinese 为句级译文。
 */

export const preprocessJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sentences"],
  properties: {
    sentences: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["words", "chinese"],
        properties: {
          words: { type: "array", items: { type: "integer" } },
          chinese: { type: "string" },
        },
      },
    },
  },
} as const;

/** 一句：词编号分组 + 该句中文（句级中文只有拆句阶段能拿到英文全文，故在此产出） */
export interface PreprocessSentence {
  words: number[];
  chinese?: string;
}

/**
 * zod 侧容错：兼容旧的 `number[][]` 输出（改了提示词但 Langfuse 还没更新、或 json_schema
 * 降级档时可能出现）。缺 chinese 不算失败——下游会回退成「结构阶段自己翻译」。
 */
const preprocessItemSchema = z.union([
  z.array(z.number().int().nonnegative()).min(1),
  z.object({
    words: z.array(z.number().int().nonnegative()).min(1),
    chinese: z.string().optional(),
  }),
]);

const preprocessSchema = z.object({
  sentences: z.array(preprocessItemSchema).min(1),
});

/** 把两种输出形状统一成 { words, chinese? }；chinese 去空白，空串视为缺失 */
export function normalizePreprocessSentences(
  items: Array<number[] | { words?: number[]; chinese?: string }>,
): PreprocessSentence[] {
  return items.map((item) => {
    if (Array.isArray(item)) {
      return { words: item };
    }
    // strictNullChecks=false 下 zod 会把 required 字段推断成可选，这里兜一层；
    // 真缺 words 时交给 validatePartition 报「只覆盖了 0/N 个词」
    const words = item.words ?? [];
    const chinese = item.chinese?.trim();
    return chinese ? { words, chinese } : { words };
  });
}

/**
 * 预处理系统提示词（**本地兜底**）：正常运行时从 Langfuse Prompt Management 拉取，
 * 未配置 key / 拉取失败 / 变量不匹配 / LANGFUSE_PROMPTS=0 时用这份；名字见 PREPROCESS_PROMPT_NAME。
 *
 * 形态：一条 system 消息，静态指令 + 末尾「## 本次输入」变量区
 * （`{{transcript}}` / `{{words}}` / `{{note}}`），代码不再拼 user 消息。
 */
export const PREPROCESS_SYSTEM_PROMPT = `你在为「蚯蚓学英语」预处理英文语音转写结果：把一段连续转写划分成一个个完整句子，并给出每句的中文翻译。

注意：转写可能把一个词拦腰拆成相邻的多个碎片（如 "Genu"+"inely"、"I"+"'"+"ve"），它们属于同一个词，必须划在同一句，不得拆开。

划分原则——尽量保留长难句，句子尽量越长越好：
1. 默认不拆：长句里带多个从句、并列成分、插入语、修饰语时，把这些内容留在同一句，保持句子的完整结构。
2. 只有在确实出现两个语义独立、各自都有完整主语和谓语的句子时，才把它们切开。
3. 以下情况都不算句子边界，不要因此切分：逗号/分号处的停顿、and/but/or/so 等并列连接、which/who/that 等引导的定语从句、because/although/if/when/while 等引导的状语从句、同位语、插入语、列举。
4. 不要为了"长"把两个不相干的句子合并：语义独立就切开，仍属于同一句的意思就保留在一起。

翻译要求（每句都要给）：
1. 中文要通顺自然、意思准确，读起来像正常的中文，不要逐词硬译。
2. 翻译的是这句 words 按顺序拼起来的完整意思：从句、非谓语、修饰成分都不能漏，也不要带上其他句子的内容。
3. 人名、地名、作品名等专有名词保留原文，不音译、不改写。
4. 只给中文，不要加引号、不要给英文原文、不要写解释。

铁律：
1. 每句应是一个意思完整的句子，按你对语义的理解划分，不局限于标点。
2. 输出每句包含的词编号 words：各句编号升序排列，合起来恰好不重不漏地覆盖全部编号（0 到 N-1），句内编号也必须升序连续。
3. 不得增删改任何词，不得调整词序。
4. chinese 必须非空，且只对应这一句的 words。

示例 1——词表编号 0..5 对应 "I like the food. It is good."（两个独立句，切开）：
输出：{"sentences":[{"words":[0,1,2,3],"chinese":"我喜欢这个食物。"},{"words":[4,5],"chinese":"它很好。"}]}

示例 2——词表编号 0..12 对应 "The book that she recommended, which I found in the library, was difficult."（一个长难句，定语从句和逗号都不切）
输出：{"sentences":[{"words":[0,1,2,3,4,5,6,7,8,9,10,11,12],"chinese":"她推荐的那本我在图书馆找到的书，很难懂。"}]}

## 本次输入
整段文本：{{transcript}}
词表（按 i 升序；每项 {"i":编号,"word":词文本}）：
{{words}}

【重试诊断】{{note}}
若【重试诊断】为「（无）」，忽略本节；否则按诊断修正上一次输出。`;

/** 拆句提示词在 Langfuse 中的名字（可用 FORGE_PROMPT_PREPROCESS_NAME 覆盖） */
export const PREPROCESS_PROMPT_NAME = config.preprocessPromptName;

/** 拆句提示词必须包含的变量：远端模板缺任何一个都回退本地兜底（避免模型拿不到输入） */
export const PREPROCESS_PROMPT_VARS = ["transcript", "words", "note"];

/**
 * 本轮调用的变量值。`note` 缺省用哨兵「（无）」（首次尝试没有诊断可给）；
 * 词表 JSON 故意不含 start/end：句子时间戳由 mergeWordGroup 从 ASR 原词回填，
 * 每词省一半以上 prompt token。
 */
export function buildPreprocessVars(text: string, words: AsrWordInfo[], note?: string): PromptVars {
  return {
    transcript: text,
    words: JSON.stringify(
      words.map((w, i) => ({
        i,
        word: w.word.word,
      })),
    ),
    note: note?.trim() || PROMPT_EMPTY,
  };
}

/** 取拆句提示词：Langfuse 优先，失败回退 PREPROCESS_SYSTEM_PROMPT */
export function loadPreprocessPrompt(vars?: PromptVars): Promise<ManagedPrompt> {
  return getManagedPrompt(PREPROCESS_PROMPT_NAME, PREPROCESS_SYSTEM_PROMPT, {
    vars,
    requiredVars: PREPROCESS_PROMPT_VARS,
  });
}

/**
 * 只发一条 system 消息：指令与变量都在提示词里。
 * 变量用 `compilePrompt(prompt.template, buildPreprocessVars(...))` 在调用点编译
 * （重试时 note 不同，但必须复用同一版本提示词）。
 */
export function buildPreprocessMessages(
  systemPrompt: string,
): Array<{ role: "system"; content: string }> {
  return [{ role: "system", content: systemPrompt }];
}

/**
 * 校验词序号分组：展平后必须恰为 0..wordCount-1（升序连续 partition），
 * 保证不重不漏、句间与句内顺序正确。返回错误描述；合格返回 null。
 */
export function validatePartition(groups: number[][], wordCount: number): string | null {
  let expect = 0;
  for (const [g, group] of groups.entries()) {
    if (group.length === 0) {
      return `第 ${g + 1} 句为空`;
    }
    for (const idx of group) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= wordCount) {
        return `编号 ${idx} 越界（有效范围 0..${wordCount - 1}）`;
      }
      if (idx !== expect) {
        return `编号 ${idx} 出现在期望 ${expect} 的位置（序号必须升序、连续、不重不漏覆盖 0..${wordCount - 1}）`;
      }
      expect++;
    }
  }
  if (expect !== wordCount) {
    return `只覆盖了 ${expect}/${wordCount} 个词`;
  }
  return null;
}

/** 按分组合并碎片词：attachToPrev 的词无空格拼到前一词，否则空格连接为新词；时间戳取原始词 */
export function mergeWordGroup(words: AsrWordInfo[], indexes: number[]): TranscriptWord[] {
  const merged: TranscriptWord[] = [];
  for (const i of indexes) {
    const info = words[i];
    const prev = merged[merged.length - 1];
    if (prev && info.attachToPrev) {
      prev.word += info.word.word;
      prev.end = info.word.end;
    } else {
      merged.push({ ...info.word });
    }
  }
  return merged;
}

function segmentFromWords(
  words: TranscriptWord[],
  id: number,
  chinese?: string,
): TranscriptSegment {
  const segment: TranscriptSegment = {
    id,
    start: words[0].start,
    end: words[words.length - 1].end,
    text: words.map((w) => w.word).join(" "),
    words,
  };
  // 只在真有翻译时写入，避免老数据/降级场景落一个 undefined 键
  if (chinese) segment.chinese = chinese;
  return segment;
}

/** 单个 ASR 段：LLM 拆句 + 校验 + 合并，失败重试一次后仍不合格则抛错 */
async function splitSegment(parts: AsrSegmentParts, label: string): Promise<TranscriptSegment[]> {
  const attempts = 2;
  // 提示词只取一次（进程内有缓存），失败重试复用同一版本，避免两次尝试用了不同版本的提示词
  const prompt = await loadPreprocessPrompt();
  // 显式 link 是双保险：propagateAttributes 是主路径，见 prompt-store.ts 的 withPrompt
  const link =
    !prompt.isFallback && prompt.version
      ? { name: prompt.name, version: prompt.version }
      : undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const note =
        attempt > 1
          ? `上一次输出不合格：${(lastError as Error).message}。请重新输出：各句词编号合起来恰好不重不漏覆盖 0..${parts.words.length - 1}，升序连续；每句的 chinese 必须非空。`
          : undefined;
      // note 每次尝试不同，所以按模板重新编译；提示词版本（prompt）保持不变
      const system = compilePrompt(
        prompt.template,
        buildPreprocessVars(parts.text, parts.words, note),
      );
      const raw = await withPrompt(prompt, () =>
        callLlmJson(
          buildPreprocessMessages(system),
          preprocessJsonSchema,
          config.preprocessModel,
          link,
        ),
      );
      const parsed = preprocessSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          `输出结构不合法：${parsed.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
        );
      }
      const sentences = normalizePreprocessSentences(parsed.data.sentences);
      const invalid = validatePartition(
        sentences.map((s) => s.words),
        parts.words.length,
      );
      if (invalid) {
        throw new Error(`词序号分组不合法：${invalid}`);
      }
      if (sentences.every((s) => !s.chinese)) {
        console.warn(
          `[preprocess] ${label}：模型没返回句级中文（确认 Langfuse 提示词已换成含 chinese 的新版），结构阶段将回退为模型自己翻译`,
        );
      }
      return sentences.map((s) =>
        segmentFromWords(mergeWordGroup(parts.words, s.words), 0, s.chinese),
      );
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        console.warn(`[preprocess] ${label} 失败，重试一次：${(error as Error).message}`);
      }
    }
  }
  throw new Error(
    `[preprocess] ${label} 最终失败（已尝试 ${attempts} 次）：${(lastError as Error).message}`,
  );
}

/**
 * 预处理整个转写：每个 ASR 段一次 LLM 调用（同步 ASR 通常只有一段），并发执行。
 * 段级降级（无词时间戳）或单词段跳过 LLM。失败直接抛错，不做降级兜底。
 */
export async function preprocessTranscript(
  transcript: Transcript,
  rawSentences: QwenAsrSentence[],
): Promise<Transcript> {
  if (!transcript.wordLevel) {
    return transcript;
  }
  const partsList = rawSentences
    .map(asrSegmentParts)
    .filter((p): p is AsrSegmentParts => p !== null);

  const results = await mapWithConcurrency(
    partsList,
    config.llmConcurrency,
    async (parts, index) => {
      const label = `段 ${index + 1}/${partsList.length}`;
      if (parts.words.length <= 1) {
        return parts.words.length === 1
          ? [segmentFromWords([parts.words[0].word], 0)]
          : [{ id: 0, start: parts.start, end: parts.end, text: parts.text }];
      }
      console.log(`[preprocess] ${label}：${parts.words.length} 个 ASR 词，交给 LLM 拆句...`);
      const segments = await splitSegment(parts, label);
      const mergedCount = segments.reduce((n, s) => n + (s.words?.length ?? 0), 0);
      console.log(
        `[preprocess] ${label} 完成：${parts.words.length} 个碎片词 -> ${segments.length} 个完整句（合并后 ${mergedCount} 词）`,
      );
      return segments;
    },
  );

  const segments = results.flat().map((seg, i) => ({ ...seg, id: i }));
  if (segments.length === 0) {
    throw new Error("[preprocess] 预处理结果为空");
  }
  return { wordLevel: transcript.wordLevel, language: transcript.language, segments };
}

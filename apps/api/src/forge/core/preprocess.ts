import { z } from "zod";

import type { AsrSegmentParts, AsrWordInfo, QwenAsrSentence } from "./asr";
import type { Transcript, TranscriptSegment, TranscriptWord } from "./types";
import { asrSegmentParts } from "./asr";
import { config } from "./config";
import { callLlmJson, mapWithConcurrency } from "./llm";

/**
 * 预处理：ASR 同步返回整段 text + 碎片词表（一个词可能被拦腰拆成 "Genu"+"inely"、
 * "I"+"'"+"ve"）。LLM 按语义理解把词序号划分成完整句子（不局限于标点），
 * 代码按分组确定性地合并碎片词、从原始 ASR 词取时间戳——时间戳零幻觉。
 * 输出契约与下游一致：一个 segment 即一个完整句，text = words.join(" ")。
 */

export const preprocessJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sentences"],
  properties: {
    sentences: {
      type: "array",
      items: { type: "array", items: { type: "integer" } },
    },
  },
} as const;

const preprocessSchema = z.object({
  sentences: z.array(z.array(z.number().int().nonnegative()).min(1)).min(1),
});

const PREPROCESS_SYSTEM_PROMPT = `你在为「蚯蚓学英语」预处理英文语音转写结果：把一段连续转写划分成一个个完整句子。

输入是整段文本和按顺序编号的词表（i 为词编号，word 为词文本，start/end 为秒级时间戳，可参考停顿）。
注意：转写可能把一个词拦腰拆成相邻的多个碎片（如 "Genu"+"inely"、"I"+"'"+"ve"），它们属于同一个词，必须划在同一句，不得拆开。

划分原则——尽量保留长难句，句子尽量越长越好：
1. 默认不拆：长句里带多个从句、并列成分、插入语、修饰语时，把这些内容留在同一句，保持句子的完整结构。
2. 只有在确实出现两个语义独立、各自都有完整主语和谓语的句子时，才把它们切开。
3. 以下情况都不算句子边界，不要因此切分：逗号/分号处的停顿、and/but/or/so 等并列连接、which/who/that 等引导的定语从句、because/although/if/when/while 等引导的状语从句、同位语、插入语、列举。
4. 不要为了"长"把两个不相干的句子合并：语义独立就切开，仍属于同一句的意思就保留在一起。

铁律：
1. 每句应是一个意思完整的句子，按你对语义的理解划分，不局限于标点。
2. 输出每句包含的词编号：各句编号升序排列，合起来恰好不重不漏地覆盖全部编号（0 到 N-1），句内编号也必须升序连续。
3. 不得增删改任何词，不得调整词序。

示例 1——词表编号 0..5 对应 "I like the food. It is good."（两个独立句，切开）：
输出：{"sentences":[[0,1,2,3],[4,5]]}

示例 2——词表编号 0..12 对应 "The book that she recommended, which I found in the library, was difficult."（一个长难句，定语从句和逗号都不切）
输出：{"sentences":[[0,1,2,3,4,5,6,7,8,9,10,11,12]]}`;

export function buildPreprocessMessages(
  text: string,
  words: AsrWordInfo[],
  note?: string,
): Array<{ role: "system" | "user"; content: string }> {
  const list = words.map((w, i) => ({
    i,
    word: w.word.word,
    start: w.word.start,
    end: w.word.end,
  }));
  return [
    { role: "system", content: PREPROCESS_SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `请把下面的转写按语义划分成完整句子（尽量保留长难句，只在真正的独立句处切开），输出每句包含的词编号。\n` +
        `整段文本：${text}\n词表（共 ${words.length} 个编号 0..${words.length - 1}）：\n${JSON.stringify(list)}` +
        (note ? `\n\n${note}` : ""),
    },
  ];
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

function segmentFromWords(words: TranscriptWord[], id: number): TranscriptSegment {
  return {
    id,
    start: words[0].start,
    end: words[words.length - 1].end,
    text: words.map((w) => w.word).join(" "),
    words,
  };
}

/** 单个 ASR 段：LLM 拆句 + 校验 + 合并，失败重试一次后仍不合格则抛错 */
async function splitSegment(parts: AsrSegmentParts, label: string): Promise<TranscriptSegment[]> {
  const attempts = 2;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const note =
        attempt > 1
          ? `上一次输出不合格：${(lastError as Error).message}。请重新输出：各句词编号合起来恰好不重不漏覆盖 0..${parts.words.length - 1}，升序连续。`
          : undefined;
      const raw = await callLlmJson(
        buildPreprocessMessages(parts.text, parts.words, note),
        preprocessJsonSchema,
        config.preprocessModel,
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
      const invalid = validatePartition(parsed.data.sentences, parts.words.length);
      if (invalid) {
        throw new Error(`词序号分组不合法：${invalid}`);
      }
      return parsed.data.sentences.map((group) =>
        segmentFromWords(mergeWordGroup(parts.words, group), 0),
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

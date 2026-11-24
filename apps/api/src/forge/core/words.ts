import type { Transcript } from "./types";

/**
 * 词表口径的唯一来源：预处理后的一句话 = 一个 segment，句子里的"词"由本文件定义，
 * 结构化（编号词表）、对齐（时间戳匹配）必须共用同一套切片，否则编号无法映射到 refs。
 */

/** 转写词在扁平序列中的引用 */
export interface WordRef {
  raw: string;
  norm: string;
  start: number;
  end: number;
}

/** 一个 segment 在 refs 里的半开区间，下标与 transcript.segments 一一对应 */
export interface SegmentRange {
  start: number;
  end: number;
}

export interface TokenUniverse {
  refs: WordRef[];
  segmentRanges: SegmentRange[];
}

export interface Token {
  raw: string;
  norm: string;
}

/** 句子级编号词表：原始拼写（含标点）+ 它在 refs 里的半开区间 */
export interface SentenceWordView {
  words: string[];
  wordStart: number;
  wordEnd: number;
}

export function normalizeToken(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function tokenize(text: string): Token[] {
  return text
    .split(/\s+/)
    .map((raw) => ({ raw, norm: normalizeToken(raw) }))
    .filter((t) => t.norm.length > 0);
}

/**
 * 摊平转写为全局词序列。词级模式下把 whisper 的撇号粘连切分
 * （"don" + "'t"）合回一个词，保证与 statement 的 "don't" 归一化后一致；
 * 纯标点 token（normalizeToken 为空）跳过，不参与编号也不参与对齐。
 * 段级降级模式下按 segment.text 分词，每个 token 指向所属 segment 的时间。
 * 同时记录每个原始 segment 对应的 [wordStart, wordEnd) 区间（空段也记录，保证下标对齐）。
 */
export function buildTokenUniverse(transcript: Transcript): TokenUniverse {
  const refs: WordRef[] = [];
  const segmentRanges: SegmentRange[] = [];

  for (const seg of transcript.segments) {
    const start = refs.length;
    if (transcript.wordLevel && seg.words && seg.words.length > 0) {
      for (const w of seg.words) {
        const raw = w.word.trim();
        if (!raw) continue;
        // "'t" / "'s" 这类碎片并入前一个词（不跨 segment）
        if (raw.startsWith("'") && refs.length > start) {
          const prev = refs[refs.length - 1];
          prev.raw += raw;
          prev.norm = normalizeToken(prev.raw);
          prev.end = w.end;
          continue;
        }
        const norm = normalizeToken(raw);
        if (!norm) continue;
        refs.push({ raw, norm, start: w.start, end: w.end });
      }
    } else {
      for (const t of tokenize(seg.text)) {
        refs.push({ raw: t.raw, norm: t.norm, start: seg.start, end: seg.end });
      }
    }
    segmentRanges.push({ start, end: refs.length });
  }
  return { refs, segmentRanges };
}

/**
 * 取某一句的编号词表：编号 i 对应 refs[wordStart + i]，即第 i 个词。
 * 空段（无词）返回 null——调用方应跳过该句，不发起模型调用。
 */
export function sentenceWordView(
  universe: TokenUniverse,
  segmentIndex: number,
): SentenceWordView | null {
  const range = universe.segmentRanges[segmentIndex];
  if (!range || range.end <= range.start) {
    return null;
  }
  return {
    words: universe.refs.slice(range.start, range.end).map((r) => r.raw),
    wordStart: range.start,
    wordEnd: range.end,
  };
}

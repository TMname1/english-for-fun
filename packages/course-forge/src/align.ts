import type { DraftStatement, Transcript, TranscriptSegment } from "./types";

export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

export interface AlignedTiming {
  startTime: number;
  endTime: number;
  /** 段级降级（无词时间戳）时为 null */
  words: WordTiming[] | null;
}

export type AlignMatchKind = "anchor" | "fragment" | "fuzzy" | "failed";

export interface AlignEntry {
  index: number;
  english: string;
  kind: AlignMatchKind;
  startTime: number | null;
  endTime: number | null;
}

export interface AlignmentReport {
  wordLevel: boolean;
  total: number;
  exact: number;
  fuzzy: number;
  failed: number;
  rate: number;
  entries: AlignEntry[];
}

export interface AlignResult {
  /** 与 statements 等长；对齐失败的位置为 null */
  timings: (AlignedTiming | null)[];
  report: AlignmentReport;
}

interface Token {
  raw: string;
  norm: string;
}

/** 转写词在扁平序列中的引用 */
interface WordRef {
  raw: string;
  norm: string;
  start: number;
  end: number;
}

/** 完整句（mergeSegments 同款断句逻辑）在 WordRef 序列上的跨度 */
interface SentenceSpan {
  wordStart: number;
  wordEnd: number;
  norms: string[];
}

export function normalizeToken(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function tokenize(text: string): Token[] {
  return text
    .split(/\s+/)
    .map((raw) => ({ raw, norm: normalizeToken(raw) }))
    .filter((t) => t.norm.length > 0);
}

/**
 * 摊平转写为全局词序列。词级模式下把 whisper 的撇号粘连切分
 * （"don" + "'t"）合回一个词，保证与 statement 的 "don't" 归一化后一致。
 * 段级降级模式下按 segment.text 分词，每个 token 指向所属 segment 的时间。
 * 同时记录每个原始 segment 对应的 [wordStart, wordEnd) 区间。
 */
function buildWordRefs(transcript: Transcript): {
  refs: WordRef[];
  segmentRanges: Array<{ start: number; end: number }>;
} {
  const refs: WordRef[] = [];
  const segmentRanges: Array<{ start: number; end: number }> = [];

  for (const seg of transcript.segments) {
    const start = refs.length;
    if (transcript.wordLevel && seg.words && seg.words.length > 0) {
      for (const w of seg.words) {
        const raw = w.word.trim();
        if (!raw) continue;
        // "'t" / "'s" 这类碎片并入前一个词
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

/** 句末判定与 llm.ts mergeSegments 保持一致 */
const SENTENCE_END = /[.!?]["'”’)\]]*$/;

/**
 * 在原始 segment 上重放 mergeSegments 的拼句逻辑，
 * 额外记录每个完整句覆盖的 WordRef 区间（mergeSegments 本身丢弃了 words）。
 */
function buildSentenceSpans(
  segments: TranscriptSegment[],
  segmentRanges: Array<{ start: number; end: number }>,
  refs: WordRef[],
): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  let pending = "";
  let pendingSegStart = -1;

  const flush = (lastSegIdx: number, force: boolean): void => {
    if (!pending.trim()) return;
    if (!force && !SENTENCE_END.test(pending)) return;
    const wordStart = segmentRanges[pendingSegStart]?.start ?? 0;
    const wordEnd = segmentRanges[lastSegIdx]?.end ?? refs.length;
    spans.push({
      wordStart,
      wordEnd,
      norms: refs.slice(wordStart, wordEnd).map((r) => r.norm),
    });
    pending = "";
    pendingSegStart = -1;
  };

  segments.forEach((seg, i) => {
    const text = seg.text.trim();
    if (!text) return;
    if (!pending) pendingSegStart = i;
    pending = pending ? `${pending} ${text}` : text;
    if (SENTENCE_END.test(pending)) {
      flush(i, false);
    }
  });
  if (pending && pendingSegStart >= 0) {
    flush(segments.length - 1, true);
  }
  return spans;
}

function findExactOccurrences(refs: WordRef[], norms: string[], from: number): number[] {
  if (norms.length === 0) return [];
  const hits: number[] = [];
  for (let p = from; p + norms.length <= refs.length; p++) {
    if (refs[p].norm !== norms[0]) continue;
    let ok = true;
    for (let k = 1; k < norms.length; k++) {
      if (refs[p + k].norm !== norms[k]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(p);
  }
  return hits;
}

/** 允许 ≤1 次编辑（替换/多一词/少一词）的匹配，返回消耗的 ref 终点（不含）；失败返回 -1 */
function fuzzyMatchAt(
  refs: WordRef[],
  i: number,
  norms: string[],
  j: number,
  budget: number,
): number {
  while (j < norms.length) {
    if (i >= refs.length) return -1;
    if (refs[i].norm === norms[j]) {
      i++;
      j++;
      continue;
    }
    if (budget <= 0) return -1;
    // 替换
    const sub = fuzzyMatchAt(refs, i + 1, norms, j + 1, budget - 1);
    if (sub >= 0) return sub;
    // statement 多了一个词（转写里没有）
    const del = fuzzyMatchAt(refs, i, norms, j + 1, budget - 1);
    if (del >= 0) return del;
    // 转写多了一个词（statement 里漏抄）
    const ins = fuzzyMatchAt(refs, i + 1, norms, j, budget - 1);
    return ins;
  }
  return i;
}

function findFuzzyOccurrences(
  refs: WordRef[],
  norms: string[],
): Array<{ start: number; end: number }> {
  const hits: Array<{ start: number; end: number }> = [];
  for (let p = 0; p < refs.length; p++) {
    const end = fuzzyMatchAt(refs, p, norms, 0, 1);
    // 消耗长度偏离 norms.length 超过 1 的不算（编辑距离已限制，双保险）
    if (end > p && Math.abs(end - p - norms.length) <= 1) {
      hits.push({ start: p, end });
    }
  }
  return hits;
}

/**
 * 把 statements 对齐到转写的词级时间戳。
 *
 * statement 是「单词 → 短语 → 整句」组装链，碎片在转写里会重复出现
 * （副歌/口头禅），因此消歧分两遍：
 * Pass 1 锚点句——token 序列与某个完整句全等的 statement 按顺序单调匹配；
 * Pass 2 碎片——收集全部出现位置，优先落在「下一个锚点句」span 内，
 * 其次距上一条匹配位置（游标）最近。
 * 精确失败允许 ≤1 词的模糊匹配（仅结果唯一时采信），仍失败置 null。
 */
export function alignStatements(transcript: Transcript, statements: DraftStatement[]): AlignResult {
  const { refs, segmentRanges } = buildWordRefs(transcript);
  const sentences = buildSentenceSpans(transcript.segments, segmentRanges, refs);

  const statementTokens = statements.map((s) => tokenize(s.english));
  const timings: (AlignedTiming | null)[] = new Array(statements.length).fill(null);
  const entries: AlignEntry[] = statements.map((s, i) => ({
    index: i,
    english: s.english,
    kind: "failed" as AlignMatchKind,
    startTime: null,
    endTime: null,
  }));

  const makeTiming = (
    start: number,
    end: number,
    tokens: Token[],
    wordLevel: boolean,
  ): AlignedTiming => ({
    startTime: refs[start].start,
    endTime: refs[end - 1].end,
    words: wordLevel
      ? tokens.map((t, k) => ({
          word: t.raw,
          start: refs[start + k].start,
          end: refs[start + k].end,
        }))
      : null,
  });

  // Pass 1：锚点句（单调对齐，游标只前进；找不到再回看已用过的区间）
  const anchorOf = new Map<number, number>(); // statement index -> sentence index
  let sentCursor = 0;
  statementTokens.forEach((tokens, i) => {
    if (tokens.length === 0) return;
    const norms = tokens.map((t) => t.norm);
    let found = -1;
    for (let s = sentCursor; s < sentences.length; s++) {
      if (norms.join("\u0000") === sentences[s].norms.join("\u0000")) {
        found = s;
        break;
      }
    }
    if (found < 0) {
      for (let s = 0; s < sentCursor; s++) {
        if (norms.join("\u0000") === sentences[s].norms.join("\u0000")) {
          found = s;
          break;
        }
      }
    }
    if (found >= 0) {
      anchorOf.set(i, found);
      sentCursor = found + 1;
    }
  });

  // 每个 statement 的目标锚点句 span：最近的「后一个」锚点句，没有则取前一个
  const anchorStmtIndexes = [...anchorOf.keys()].sort((a, b) => a - b);
  const targetSpanOf = (i: number): SentenceSpan | null => {
    const next = anchorStmtIndexes.find((idx) => idx >= i && idx !== i);
    const prev = [...anchorStmtIndexes].reverse().find((idx) => idx < i);
    const stmtIdx = next ?? prev;
    if (stmtIdx === undefined) return null;
    const sentIdx = anchorOf.get(stmtIdx);
    return sentIdx === undefined ? null : sentences[sentIdx];
  };

  // Pass 2：按顺序逐条定位，游标为上一条匹配的结束词位置
  let cursor = 0;
  statementTokens.forEach((tokens, i) => {
    if (tokens.length === 0) return;
    const norms = tokens.map((t) => t.norm);

    const anchorIdx = anchorOf.get(i);
    if (anchorIdx !== undefined) {
      const span = sentences[anchorIdx];
      timings[i] = makeTiming(span.wordStart, span.wordEnd, tokens, transcript.wordLevel);
      entries[i] = {
        ...entries[i],
        kind: "anchor",
        startTime: timings[i]!.startTime,
        endTime: timings[i]!.endTime,
      };
      cursor = span.wordEnd;
      return;
    }

    const target = targetSpanOf(i);
    const occurrences = findExactOccurrences(refs, norms, 0);
    if (occurrences.length > 0) {
      const score = (p: number): number => {
        const inside =
          target !== null && p >= target.wordStart && p + norms.length <= target.wordEnd;
        return (inside ? 0 : 100_000) + Math.abs(p - cursor);
      };
      let best = occurrences[0];
      for (const p of occurrences) {
        if (score(p) < score(best)) best = p;
      }
      timings[i] = makeTiming(best, best + norms.length, tokens, transcript.wordLevel);
      entries[i] = {
        ...entries[i],
        kind: "fragment",
        startTime: timings[i]!.startTime,
        endTime: timings[i]!.endTime,
      };
      cursor = best + norms.length;
      return;
    }

    // 模糊兜底：仅当候选唯一时采信
    const fuzzyHits = findFuzzyOccurrences(refs, norms);
    if (fuzzyHits.length === 1) {
      const { start, end } = fuzzyHits[0];
      // 模糊匹配的 ref 数可能与 token 数不等，words 逐词映射不可靠时置 null
      const words =
        transcript.wordLevel && end - start === tokens.length
          ? tokens.map((t, k) => ({
              word: t.raw,
              start: refs[start + k].start,
              end: refs[start + k].end,
            }))
          : null;
      const timing: AlignedTiming = {
        startTime: refs[start].start,
        endTime: refs[end - 1].end,
        words,
      };
      timings[i] = timing;
      entries[i] = {
        ...entries[i],
        kind: "fuzzy",
        startTime: timing.startTime,
        endTime: timing.endTime,
      };
      cursor = end;
    }
  });

  const exact = entries.filter((e) => e.kind === "anchor" || e.kind === "fragment").length;
  const fuzzy = entries.filter((e) => e.kind === "fuzzy").length;
  const failed = entries.filter((e) => e.kind === "failed").length;
  const total = statements.length;

  return {
    timings,
    report: {
      wordLevel: transcript.wordLevel,
      total,
      exact,
      fuzzy,
      failed,
      rate: total > 0 ? (exact + fuzzy) / total : 0,
      entries,
    },
  };
}

export function formatAlignmentSummary(report: AlignmentReport): string {
  const granularity = report.wordLevel ? "词级" : "段级降级（无单词时间戳）";
  return (
    `对齐完成（${granularity}）：${report.exact + report.fuzzy}/${report.total} 成功` +
    `（精确 ${report.exact}、模糊 ${report.fuzzy}、失败 ${report.failed}）`
  );
}

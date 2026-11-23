import type { DraftStatement, StatementSpan, Transcript } from "./types";
import type { Token, WordRef } from "./words";
import { buildTokenUniverse, tokenize } from "./words";

export { normalizeToken } from "./words";

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

export type AlignMatchKind = "anchor" | "fragment" | "fuzzy" | "span" | "failed";

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
  /** anchor + fragment（不含 span 直取） */
  exact: number;
  /** 由词编号 span 直接取到的条数 */
  spanned: number;
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

/** 完整句（预处理后一个 segment 即一句）在 WordRef 序列上的跨度 */
interface SentenceSpan {
  wordStart: number;
  wordEnd: number;
  norms: string[];
}

/**
 * 预处理已把转写拆成完整句（一个 segment 即一句），
 * 每个非空 segment 的词区间就是一个句子跨度。
 */
function buildSentenceSpans(
  segmentRanges: Array<{ start: number; end: number }>,
  refs: WordRef[],
): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  for (const { start, end } of segmentRanges) {
    if (end <= start) continue;
    spans.push({
      wordStart: start,
      wordEnd: end,
      norms: refs.slice(start, end).map((r) => r.norm),
    });
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
 *
 * 若调用方传入了结构化阶段产出的词编号 span（全局 ref 半开区间），
 * 该条直接取 refs 的时间与逐词时间戳（kind = "span"），不参与上述任何猜测式匹配；
 * 无 span / span 越界或长度不符（旧进度快照、转写被人工改过）则自动退回原匹配逻辑。
 */
export function alignStatements(
  transcript: Transcript,
  statements: DraftStatement[],
  spans?: ReadonlyArray<StatementSpan | null | undefined>,
): AlignResult {
  const { refs, segmentRanges } = buildTokenUniverse(transcript);
  const sentences = buildSentenceSpans(segmentRanges, refs);

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

  // 编号直取：词编号 span 来自结构化阶段（可能含全局 ref 下标），
  // 校验通过就直接取时间与逐词时间戳，不再参与下面的猜测式匹配。
  const spanned = new Set<number>();
  statements.forEach((_, i) => {
    const span = spans?.[i];
    if (!span) return;
    const { wordStart, wordEnd } = span;
    if (
      !Number.isInteger(wordStart) ||
      !Number.isInteger(wordEnd) ||
      wordStart < 0 ||
      wordEnd <= wordStart ||
      wordEnd > refs.length
    ) {
      return;
    }
    // span 长度必须与实际词数一致（重建 english 与编号 1:1，长度不等说明快照陈旧）
    if (wordEnd - wordStart !== statementTokens[i].length) return;
    timings[i] = {
      startTime: refs[wordStart].start,
      endTime: refs[wordEnd - 1].end,
      words: transcript.wordLevel
        ? refs.slice(wordStart, wordEnd).map((r) => ({ word: r.raw, start: r.start, end: r.end }))
        : null,
    };
    entries[i] = {
      ...entries[i],
      kind: "span",
      startTime: timings[i]!.startTime,
      endTime: timings[i]!.endTime,
    };
    spanned.add(i);
  });

  const pending = statements.map((_, i) => i).filter((i) => !spanned.has(i));

  // Pass 1：锚点句（单调对齐，游标只前进；找不到再回看已用过的区间）
  const anchorOf = new Map<number, number>(); // statement index -> sentence index
  let sentCursor = 0;
  pending.forEach((i) => {
    const tokens = statementTokens[i];
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
  pending.forEach((i) => {
    const tokens = statementTokens[i];
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
  const spannedCount = entries.filter((e) => e.kind === "span").length;
  const fuzzy = entries.filter((e) => e.kind === "fuzzy").length;
  const failed = entries.filter((e) => e.kind === "failed").length;
  const total = statements.length;

  return {
    timings,
    report: {
      wordLevel: transcript.wordLevel,
      total,
      exact,
      spanned: spannedCount,
      fuzzy,
      failed,
      rate: total > 0 ? (exact + spannedCount + fuzzy) / total : 0,
      entries,
    },
  };
}

export function formatAlignmentSummary(report: AlignmentReport): string {
  const granularity = report.wordLevel ? "词级" : "段级降级（无单词时间戳）";
  const detail =
    report.spanned > 0
      ? `（编号直取 ${report.spanned}、精确 ${report.exact}、模糊 ${report.fuzzy}、失败 ${report.failed}）`
      : `（精确 ${report.exact}、模糊 ${report.fuzzy}、失败 ${report.failed}）`;
  return (
    `对齐完成（${granularity}）：${report.exact + report.spanned + report.fuzzy}/${report.total} 成功` +
    detail
  );
}

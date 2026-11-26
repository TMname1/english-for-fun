/**
 * 切块规划：把 captioner 给的语音段装成「每块 ≤ maxMs」的块。
 *
 * 全部是纯函数（无 fs / 无网络 / 无 Date），因为这里最容易出「整体偏移一个 clip.start」
 * 「边界词重复」「最后一块只剩 0.2 秒」这类只有靠密集单测才能兜住的错。
 *
 * ## 时间基准（全局只加两次，绝不用 offsetTranscript）
 *
 *   unit = 一个 clip 或整段；unit.baseMs = clip ? clip.start*1000 : 0
 *   caption 绝对   = unit.baseMs + span.beginMs
 *   chunk.audio    = [core.start - pad, core.end + pad] clamp 到 unit 范围
 *   chunk.local    = chunk.audio - unit.baseMs            （ffmpeg -ss/-t 用这个）
 *   词绝对时间     = chunk.audio.start + qwenWord.begin_time
 *
 * ## 为什么 core 是半开区间 [start, end)
 *
 * 相邻块的 core 首尾相接、不重叠，配合「词中点落在归属窗口内才保留」的规则，
 * 任何词只会属于唯一一块——既不会丢，也不会重复。padding 只扩大音频取材范围，
 * 不改变归属判定；唯一的例外是首/末块（没有邻块，不存在重复风险）会把归属窗口
 * 扩展到 padding 边缘，见 `ChunkSpec.keep`。
 */
import type { QwenAsrSentence, QwenAsrWord } from "./asr-model";
import type { ClipRange } from "./types";

export interface SpanMs {
  start: number;
  end: number;
}

export interface ChunkSpec {
  /** 所属 unit（clip 序号；无切片时为 0） */
  unitIndex: number;
  /** 与 clips.json 对齐的下标；无切片时为 0 */
  clipIndex: number;
  /** unit 内序号，从 0 开始 */
  index: number;
  /** 句边界对齐的块窗口（绝对毫秒），半开区间，块间不重叠 */
  core: SpanMs;
  /**
   * 词归属判定窗口：默认等于 `core`，但**首块向左、末块向右**扩展到 padding 边缘。
   *
   * 为什么需要它：captioner 的段起点通常比真实语音起点晚一点（实测约 0.2s），若首块
   * 也按 core 判定，开头一两个词的中点会落在 core 之前、被判成「上一块重复」而丢掉
   * （实测首句丢了 "One more"）。首块左侧 / 末块右侧本来就没有邻块，不存在重复风险，
   * 所以把归属窗口放宽到实际取材范围。
   */
  keep: SpanMs;
  /** 加 padding 并 clamp 后的实际取材窗口（绝对毫秒） */
  audio: SpanMs;
  /** 相对 unit wav 起点的窗口（毫秒），传给 ffmpeg */
  local: SpanMs;
}

/** 把超过 maxMs 的区间等分（而不是固定步长切：避免最后一段只剩几秒） */
export function splitSpan(span: SpanMs, maxMs: number): SpanMs[] {
  const length = span.end - span.start;
  if (length <= 0) return [];
  if (length <= maxMs) return [{ ...span }];
  const parts = Math.ceil(length / maxMs);
  const step = length / parts;
  return Array.from({ length: parts }, (_, i) => ({
    start: Math.round(span.start + step * i),
    end: Math.round(span.start + step * (i + 1)),
  }));
}

export interface PlanChunksArgs {
  unitIndex: number;
  clipIndex: number;
  /** 有切片时用于 clamp 与计算 local；无切片传 undefined */
  clip?: ClipRange;
  /** 该 unit 内 captioner 的语音段（**绝对毫秒**，升序） */
  spans: SpanMs[];
  /** 单块上限（毫秒） */
  maxMs: number;
  /** 前后 padding（毫秒） */
  padMs: number;
  /** 无切片时也用得上：unit 音频总时长（毫秒），用于 clamp；缺省则只 clamp 下界 */
  unitDurationMs?: number;
}

/** 相邻语音段按顺序累积成块，块边界落在段边界上 */
export function planChunks(args: PlanChunksArgs): ChunkSpec[] {
  const { unitIndex, clipIndex, clip, maxMs, padMs } = args;
  if (maxMs <= 0) throw new Error("[chunk-plan] maxMs 必须为正数");

  const unitStart = clip ? Math.round(clip.start * 1000) : 0;
  const unitEnd = clip
    ? Math.round(clip.end * 1000)
    : args.unitDurationMs !== undefined
      ? unitStart + Math.round(args.unitDurationMs)
      : Number.POSITIVE_INFINITY;

  // 1) 规整：clamp 到 unit 范围、丢弃非法段、按时间排序
  const spans = args.spans
    .map((s) => ({
      start: Math.max(unitStart, Math.round(s.start)),
      end: Math.min(unitEnd, Math.round(s.end)),
    }))
    .filter((s) => s.end - s.start > 0)
    .sort((a, b) => a.start - b.start);
  if (spans.length === 0) return [];

  // 2) 累积成组：块边界一定落在语音段边界
  const groups: SpanMs[] = [];
  let current: SpanMs | null = null;
  for (const span of spans) {
    if (!current) {
      current = { ...span };
      continue;
    }
    if (Math.max(current.end, span.end) - current.start <= maxMs) {
      current.end = Math.max(current.end, span.end);
    } else {
      groups.push(current);
      current = { ...span };
    }
  }
  if (current) groups.push(current);

  // 3) 单组超长（长独白 / 只有时长兜底）→ 等分
  const cores = groups.flatMap((g) => (g.end - g.start > maxMs ? splitSpan(g, maxMs) : [g]));

  // 4) 加 padding 并 clamp：不能借到 unit 之外的音频
  return cores.map((core, index) => {
    const audio = {
      start: Math.max(unitStart, core.start - padMs),
      end: Math.min(unitEnd, core.end + padMs),
    };
    // 首块左侧、末块右侧没有邻块，归属窗口扩展到取材边缘（见 keep 字段说明）
    const keep = {
      start: index === 0 ? audio.start : core.start,
      end: index === cores.length - 1 ? audio.end : core.end,
    };
    return {
      unitIndex,
      clipIndex,
      index,
      core,
      keep,
      audio,
      local: { start: audio.start - unitStart, end: audio.end - unitStart },
    };
  });
}

/** 词时间解析：缺任一时间戳返回 null（该词应丢弃） */
function wordTimesMs(word: QwenAsrWord): { beginMs: number; endMs: number } | null {
  const begin = Number(word.begin_time);
  const end = Number(word.end_time);
  if (!Number.isFinite(begin) || !Number.isFinite(end) || end < begin) return null;
  return { beginMs: begin, endMs: end };
}

export interface WordSelection<T> {
  kept: Array<{ raw: T; beginMs: number; endMs: number }>;
  /** 因中点落在 core 之外而被丢弃的词数（padding 重叠区的重复词） */
  dropped: number;
}

/**
 * 只保留「词中点落在归属窗口内」的词，并把块内相对时间偏移成绝对时间。
 * `offsetMs` = chunk.audio.start（绝对毫秒），`window` 传 chunk.keep（首/末块已扩展到 padding 边缘）。
 */
export function selectWordsInCore<T extends QwenAsrWord>(
  words: T[],
  window: SpanMs,
  offsetMs: number,
): WordSelection<T> {
  const kept: Array<{ raw: T; beginMs: number; endMs: number }> = [];
  let dropped = 0;
  for (const word of words) {
    const times = wordTimesMs(word);
    if (!times) {
      dropped += 1;
      continue;
    }
    const beginMs = times.beginMs + offsetMs;
    const endMs = times.endMs + offsetMs;
    const mid = (beginMs + endMs) / 2;
    if (mid >= window.start && mid < window.end) {
      kept.push({ raw: word, beginMs, endMs });
    } else {
      dropped += 1;
    }
  }
  return { kept, dropped };
}

/**
 * 修复被块边界拦腰拆开的词：上一块结尾与下一块开头时间紧邻、
 * 且下一个词没有前导空格（ASR 拆词特征 "Genu" / "inely"）时，把碎片拼回一个词。
 *
 * 同一块内的碎片由 `preprocessTranscript` 的 attachToPrev 逻辑处理，这里只补跨块的。
 */
export function repairChunkBoundaries(sentences: QwenAsrSentence[]): {
  sentences: QwenAsrSentence[];
  merged: number;
} {
  let merged = 0;
  for (let i = 0; i < sentences.length - 1; i += 1) {
    const prev = sentences[i];
    const next = sentences[i + 1];
    const prevWords = prev?.words ?? [];
    const nextWords = next?.words ?? [];
    if (prevWords.length === 0 || nextWords.length === 0) continue;

    const tail = prevWords[prevWords.length - 1];
    const head = nextWords[0];
    const tailEnd = Number(tail.end_time);
    const headBegin = Number(head.begin_time);
    if (!Number.isFinite(tailEnd) || !Number.isFinite(headBegin)) continue;
    // 时间上必须紧邻（≤60ms 缝隙），且下一个词没有前导空格 → 同一个词被切断
    if (headBegin - tailEnd > 60) continue;
    if (/^\s/.test(head.text ?? "")) continue;

    tail.text = `${(tail.text ?? "").trim()}${(head.text ?? "").trim()}`;
    tail.punctuation = `${tail.punctuation ?? ""}${head.punctuation ?? ""}`;
    tail.end_time = head.end_time;
    nextWords.shift();
    merged += 1;

    if (nextWords.length > 0) {
      next.begin_time = nextWords[0].begin_time;
      next.text = nextWords
        .map((w) => `${(w.text ?? "").trim()}${w.punctuation ?? ""}`)
        .join(" ")
        .trim();
    }
  }

  // 变空的块直接去掉（该块的全部内容已并入前一块）
  const kept = sentences.filter((s) => (s.words?.length ?? 0) > 0);
  return { sentences: kept, merged };
}

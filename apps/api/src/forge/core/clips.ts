import type { ClipRange, Transcript, TranscriptSegment } from "./types";

const EPS = 0.05;
const MIN_CLIP_SECONDS = 0.1;

/** 排序、丢弃过短区间、clamp 到 [0, duration]；返回按时间升序的 clips（不合并，相邻分段各自保留） */
export function normalizeClips(clips: ClipRange[], duration?: number): ClipRange[] {
  return clips
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end))
    .map((c) => ({
      start: Math.max(0, c.start),
      end: duration !== undefined ? Math.min(duration, c.end) : c.end,
    }))
    .filter((c) => c.end - c.start >= MIN_CLIP_SECONDS)
    .sort((a, b) => a.start - b.start);
}

/** 把单个 clip 的转写时间戳（相对 clip 起点）加回偏移，映射到原视频绝对时间 */
export function offsetTranscript(transcript: Transcript, offset: number): Transcript {
  return {
    ...transcript,
    segments: transcript.segments.map((seg) => ({
      ...seg,
      start: seg.start + offset,
      end: seg.end + offset,
      words: seg.words?.map((w) => ({ ...w, start: w.start + offset, end: w.end + offset })),
    })),
  };
}

/**
 * 按 clip 顺序合并多份转写：segment id 全局重编号（校对组件用 id 作 Vue key，
 * 各 clip 的 ASR id 都从 0 起，不重编号会冲突），并打上 clipIndex。
 */
export function mergeClipTranscripts(parts: Transcript[]): Transcript {
  const segments: TranscriptSegment[] = [];
  let wordLevel = false;
  let language = "en";
  let nextId = 0;

  parts.forEach((part, clipIndex) => {
    wordLevel = wordLevel || part.wordLevel;
    language = part.language;
    for (const seg of part.segments) {
      segments.push({ ...seg, id: nextId++, clipIndex });
    }
  });

  return { wordLevel, language, segments };
}

/**
 * structure 阶段用：按 segment.start 落在哪个 clip 区间重打 clipIndex。
 * 人工校对会重写 transcript.json（clipIndex 可能丢失），以独立落盘的 clips.json 为准。
 * 未落入任何区间的段沿用最近的前一个 clip（时间戳只会因编辑微调，不会跨区间）。
 */
export function tagClipBoundaries(
  segments: TranscriptSegment[],
  clips: ClipRange[],
): TranscriptSegment[] {
  return segments.map((seg) => {
    let index = clips.findIndex((c) => seg.start >= c.start - EPS && seg.start < c.end + EPS);
    if (index < 0) {
      index = 0;
      for (let i = 0; i < clips.length; i++) {
        if (clips[i].start <= seg.start + EPS) index = i;
      }
    }
    return { ...seg, clipIndex: index };
  });
}

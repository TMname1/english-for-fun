import type { Transcript, TranscriptSegment, TranscriptWord } from "./types";

/** 前端回传的单段编辑结果：删过的段不出现；word 数与原段一致（不增删词），仅改 word 文字 */
export interface EditedWordInput {
  word?: string | null;
  start?: number | null;
  end?: number | null;
}

export interface EditedSegmentInput {
  id?: number | null;
  start?: number | null;
  end?: number | null;
  text?: string | null;
  words?: EditedWordInput[] | null;
}

/**
 * 把人工校对（word 级改文字 + 删整段）后的转录数据规整回流水线可用的 Transcript。
 *
 * 规则：
 * - 每个 word 校验 start/end 为有限数、文字非空，与 parseTranscription 对齐口径一致；
 * - 段的 text 由编辑后的 words 重新拼接（`words.map(w => w.word).join(" ")`），
 *   因为 LLM 结构化读 segment.text、对齐读 segment.words，二者必须同步反映修正文本；
 * - 无有效 words 的段，若有 text 则保留为段级；否则整段丢弃；
 * - 全部丢弃时抛错，避免空转录进入后续流程。
 */
export function normalizeEditedTranscript(
  raw: { segments?: EditedSegmentInput[] } | null | undefined,
  language: string,
): Transcript {
  const segments: TranscriptSegment[] = [];
  let anyWords = false;

  (raw?.segments ?? []).forEach((seg, index) => {
    const start = Number(seg.start);
    const end = Number(seg.end);

    const words: TranscriptWord[] = [];
    for (const w of seg.words ?? []) {
      const ws = Number(w.start);
      const we = Number(w.end);
      const text = (w.word ?? "").trim();
      if (text && Number.isFinite(ws) && Number.isFinite(we)) {
        words.push({ word: text, start: ws, end: we });
      }
    }

    if (words.length > 0) {
      anyWords = true;
      const text = words
        .map((w) => w.word)
        .join(" ")
        .trim();
      if (!text) return;
      segments.push({
        id: Number.isFinite(Number(seg.id)) ? Number(seg.id) : index,
        start: Number.isFinite(start) ? start : words[0].start,
        end: Number.isFinite(end) ? end : words[words.length - 1].end,
        text,
        words,
      });
      return;
    }

    const fallbackText = (seg.text ?? "").trim();
    if (Number.isFinite(start) && Number.isFinite(end) && fallbackText) {
      segments.push({
        id: Number.isFinite(Number(seg.id)) ? Number(seg.id) : index,
        start,
        end,
        text: fallbackText,
        words: undefined,
      });
    }
  });

  if (segments.length === 0) {
    throw new Error("[forge] 校对后没有有效的转录分段（可能整段被删除）");
  }

  return { wordLevel: anyWords, language, segments };
}

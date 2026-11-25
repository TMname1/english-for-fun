import type { Transcript, TranscriptSegment } from "../types";
import {
  mergeClipTranscripts,
  normalizeClips,
  offsetTranscript,
  tagClipBoundaries,
} from "../clips";

describe("normalizeClips", () => {
  it("sorts by start time", () => {
    expect(
      normalizeClips([
        { start: 10, end: 20 },
        { start: 0, end: 5 },
      ]),
    ).toEqual([
      { start: 0, end: 5 },
      { start: 10, end: 20 },
    ]);
  });

  it("drops too-short and invalid clips", () => {
    expect(
      normalizeClips([
        { start: 1, end: 1.05 },
        { start: 5, end: 4 },
        { start: NaN, end: 10 },
        { start: 2, end: 6 },
      ]),
    ).toEqual([{ start: 2, end: 6 }]);
  });

  it("keeps adjacent and overlapping clips separate (no merge)", () => {
    expect(
      normalizeClips([
        { start: 0, end: 5 },
        { start: 5, end: 8 },
        { start: 7, end: 12 },
      ]),
    ).toEqual([
      { start: 0, end: 5 },
      { start: 5, end: 8 },
      { start: 7, end: 12 },
    ]);
  });

  it("clamps to duration and negatives", () => {
    expect(normalizeClips([{ start: -3, end: 100 }], 30)).toEqual([{ start: 0, end: 30 }]);
    expect(normalizeClips([{ start: 29.95, end: 100 }], 30)).toEqual([]);
  });
});

describe("offsetTranscript", () => {
  it("shifts segment and word times without mutating input", () => {
    const t: Transcript = {
      wordLevel: true,
      language: "en",
      segments: [
        {
          id: 0,
          start: 1,
          end: 3,
          text: "hello world",
          words: [{ word: "hello", start: 1, end: 2 }],
        },
      ],
    };
    const shifted = offsetTranscript(t, 10);
    expect(shifted.segments[0].start).toBe(11);
    expect(shifted.segments[0].end).toBe(13);
    expect(shifted.segments[0].words![0]).toEqual({ word: "hello", start: 11, end: 12 });
    expect(t.segments[0].start).toBe(1);
  });
});

describe("mergeClipTranscripts", () => {
  const part = (id: number, text: string): Transcript => ({
    wordLevel: false,
    language: "en",
    segments: [{ id, start: id, end: id + 1, text }],
  });

  it("renumbers segment ids globally and tags clipIndex", () => {
    const twoSegs: Transcript = {
      wordLevel: false,
      language: "en",
      segments: [
        { id: 0, start: 0, end: 1, text: "a" },
        { id: 1, start: 1, end: 2, text: "b" },
      ],
    };
    const merged = mergeClipTranscripts([twoSegs, part(0, "c")]);
    expect(merged.segments.map((s) => s.id)).toEqual([0, 1, 2]);
    expect(merged.segments.map((s) => s.clipIndex)).toEqual([0, 0, 1]);
  });

  it("wordLevel is true when any part has word timestamps", () => {
    const a = part(0, "a");
    const b = { ...part(0, "b"), wordLevel: true };
    expect(mergeClipTranscripts([a, b]).wordLevel).toBe(true);
    expect(mergeClipTranscripts([a]).wordLevel).toBe(false);
  });
});

describe("tagClipBoundaries", () => {
  const clips = [
    { start: 0, end: 5 },
    { start: 20, end: 30 },
  ];

  it("assigns clipIndex by segment start", () => {
    const tagged = tagClipBoundaries(
      [
        { id: 0, start: 1, end: 2, text: "a" },
        { id: 1, start: 21, end: 22, text: "b" },
        { id: 2, start: 29.99, end: 30, text: "c" },
      ],
      clips,
    );
    expect(tagged.map((s) => s.clipIndex)).toEqual([0, 1, 1]);
  });

  it("falls back to nearest preceding clip for out-of-range starts", () => {
    const tagged = tagClipBoundaries([{ id: 0, start: 12, end: 13, text: "gap" }], clips);
    expect(tagged[0].clipIndex).toBe(0);
  });
});

describe("句级中文随 clip 处理保留", () => {
  const seg = (text: string, chinese: string): TranscriptSegment => ({
    id: 0,
    start: 0,
    end: 1,
    text,
    chinese,
    words: [{ word: text, start: 0, end: 1 }],
  });

  it("offsetTranscript / tagClipBoundaries / mergeClipTranscripts 都不丢 chinese", () => {
    const t: Transcript = { wordLevel: true, language: "en", segments: [seg("Hi.", "你好。")] };

    const shifted = offsetTranscript(t, 10);
    expect(shifted.segments[0].chinese).toBe("你好。");
    expect(t.segments[0].chinese).toBe("你好。");

    const tagged = tagClipBoundaries(shifted.segments, [{ start: 10, end: 11 }]);
    expect(tagged[0].chinese).toBe("你好。");

    const merged = mergeClipTranscripts([
      { wordLevel: true, language: "en", segments: [seg("Hi.", "你好。")] },
      { wordLevel: true, language: "en", segments: [seg("Yo.", "哟。")] },
    ]);
    expect(merged.segments.map((s) => s.chinese)).toEqual(["你好。", "哟。"]);
    expect(merged.segments.map((s) => s.id)).toEqual([0, 1]);
  });
});

import { describe, expect, it, vi } from "vitest";

import { buildTranscriptFromSentences, transcodeToWav } from "../asr";

vi.mock("../util", () => ({ runFfmpeg: vi.fn().mockResolvedValue(undefined) }));

describe("buildTranscriptFromSentences", () => {
  it("换算毫秒为秒，保留词级时间戳并把标点并入词尾", () => {
    const sentences = [
      {
        sentence_id: 1,
        begin_time: 100,
        end_time: 2000,
        text: "I like the food.",
        sentence_end: true,
        words: [
          { text: "I", begin_time: 100, end_time: 300, punctuation: "" },
          { text: "like", begin_time: 400, end_time: 700, punctuation: "" },
          { text: "the", begin_time: 800, end_time: 900, punctuation: "" },
          { text: "food", begin_time: 1000, end_time: 1900, punctuation: "." },
        ],
      },
    ];
    const t = buildTranscriptFromSentences(sentences, "en");
    expect(t.wordLevel).toBe(true);
    expect(t.segments[0].start).toBeCloseTo(0.1);
    expect(t.segments[0].end).toBeCloseTo(2.0);
    expect(t.segments[0].id).toBe(0);
    expect(t.segments[0].words).toHaveLength(4);
    expect(t.segments[0].words![3].word).toBe("food.");
    expect(t.segments[0].words![0].start).toBeCloseTo(0.1);
  });

  it("无词级时间戳时降级为段级", () => {
    const sentences = [
      { sentence_id: 1, begin_time: 0, end_time: 2000, text: "Hello there.", sentence_end: true },
    ];
    const t = buildTranscriptFromSentences(sentences, "en");
    expect(t.wordLevel).toBe(false);
    expect(t.segments).toHaveLength(1);
    expect(t.segments[0].words).toBeUndefined();
    expect(t.segments[0].text).toBe("Hello there.");
  });

  it("丢弃缺时间戳的句子", () => {
    const sentences = [
      { sentence_id: 1, text: "oops", sentence_end: true },
      {
        sentence_id: 2,
        begin_time: 1000,
        end_time: 2000,
        text: "ok",
        sentence_end: true,
        words: [{ text: "ok", begin_time: 1000, end_time: 2000 }],
      },
    ];
    const t = buildTranscriptFromSentences(sentences, "en");
    expect(t.segments).toHaveLength(1);
    expect(t.wordLevel).toBe(true);
  });

  it("空结果抛错", () => {
    expect(() => buildTranscriptFromSentences([], "en")).toThrow(/转写结果为空/);
  });
});

describe("transcodeToWav", () => {
  it("无 range 时不插入 seek 参数", async () => {
    const { runFfmpeg } = await import("../util");
    vi.mocked(runFfmpeg).mockClear();
    await transcodeToWav("in.mp4", "out.wav");
    expect(vi.mocked(runFfmpeg).mock.calls[0][0]).toEqual([
      "-y",
      "-i",
      "in.mp4",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "out.wav",
    ]);
  });

  it("有 range 时在 -i 前插入 -ss/-t（输入侧 seek）", async () => {
    const { runFfmpeg } = await import("../util");
    vi.mocked(runFfmpeg).mockClear();
    await transcodeToWav("in.mp4", "out.wav", { start: 12.5, end: 20 });
    expect(vi.mocked(runFfmpeg).mock.calls[0][0]).toEqual([
      "-y",
      "-ss",
      "12.5",
      "-t",
      "7.5",
      "-i",
      "in.mp4",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "out.wav",
    ]);
  });
});

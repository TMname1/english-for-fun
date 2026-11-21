import {
  asrSegmentParts,
  buildTranscriptFromSentences,
  parseSyncSentence,
  transcodeToWav,
} from "../asr";

jest.mock("../util", () => ({ runFfmpeg: jest.fn().mockResolvedValue(undefined) }));

describe("parseSyncSentence", () => {
  it("同步响应 output.sentence 为单句对象时包成数组", () => {
    const sentence = {
      sentence_id: 36,
      begin_time: 600,
      end_time: 104440,
      text: "Hello.",
      sentence_end: true,
    };
    expect(parseSyncSentence({ output: { sentence } })).toEqual([sentence]);
  });

  it("防御性兼容数组写法", () => {
    const sentences = [
      { begin_time: 0, end_time: 1000, text: "a", sentence_end: true },
      { begin_time: 1000, end_time: 2000, text: "b", sentence_end: true },
    ];
    expect(parseSyncSentence({ output: { sentence: sentences } })).toEqual(sentences);
  });

  it("错误载荷（code 且无 output）抛错", () => {
    expect(() => parseSyncSentence({ code: "InvalidApiKey", message: "bad key" })).toThrow(
      /服务返回错误: InvalidApiKey bad key/,
    );
  });

  it("缺少 output.sentence 抛错", () => {
    expect(() => parseSyncSentence({ output: { text: "no sentence" } })).toThrow(
      /缺少 output.sentence/,
    );
    expect(() => parseSyncSentence({})).toThrow(/缺少 output.sentence/);
  });
});

describe("asrSegmentParts", () => {
  it("碎片词标记 attachToPrev：相邻无前导空格碎片可拼，纯空格占位词打破相邻", () => {
    const parts = asrSegmentParts({
      begin_time: 0,
      end_time: 2000,
      text: "I've Genuinely",
      sentence_end: true,
      words: [
        { text: "I", begin_time: 0, end_time: 100 },
        { text: "'", begin_time: 100, end_time: 150 },
        { text: "ve", begin_time: 150, end_time: 300 },
        { text: " ", begin_time: 300, end_time: 310 },
        { text: "Genu", begin_time: 310, end_time: 500 },
        { text: "inely", begin_time: 500, end_time: 800 },
        { text: " fun", begin_time: 800, end_time: 1500 },
      ],
    })!;
    // 纯空格 token 被过滤；I/'/ve/Genu/inely/fun 共 6 个有效词
    expect(parts.words.map((w) => w.word.word)).toEqual(["I", "'", "ve", "Genu", "inely", "fun"]);
    expect(parts.words.map((w) => w.attachToPrev)).toEqual([
      false, // 句首
      true, // ' 紧邻 I
      true, // ve 紧邻 '
      false, // Genu 前是空格占位词
      true, // inely 紧邻 Genu
      false, // fun 带前导空格
    ]);
  });
});

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
    jest.mocked(runFfmpeg).mockClear();
    await transcodeToWav("in.mp4", "out.wav");
    expect(jest.mocked(runFfmpeg).mock.calls[0][0]).toEqual([
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
    jest.mocked(runFfmpeg).mockClear();
    await transcodeToWav("in.mp4", "out.wav", { start: 12.5, end: 20 });
    expect(jest.mocked(runFfmpeg).mock.calls[0][0]).toEqual([
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

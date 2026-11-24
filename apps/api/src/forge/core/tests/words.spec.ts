import type { Transcript } from "../types";
import { buildTokenUniverse, normalizeToken, sentenceWordView } from "../words";

function wordLevelTranscript(segments: Array<{ text: string; words: string[] }>): Transcript {
  let t = 0;
  return {
    wordLevel: true,
    language: "en",
    segments: segments.map((seg, id) => {
      const words = seg.words.map((w) => {
        const start = t;
        t += 0.5;
        return { word: w, start, end: t };
      });
      return {
        id,
        start: words[0]?.start ?? 0,
        end: words[words.length - 1]?.end ?? 0,
        text: seg.text,
        words,
      };
    }),
  };
}

describe("buildTokenUniverse", () => {
  it("撇号碎片并入前一个词，且不跨 segment", () => {
    const transcript = wordLevelTranscript([
      { text: "I don 't like it.", words: ["I", "don", "'t", "like", "it."] },
      { text: "'s fine", words: ["'s", "fine"] },
    ]);
    const { refs, segmentRanges } = buildTokenUniverse(transcript);
    expect(refs.map((r) => r.raw)).toEqual(["I", "don't", "like", "it.", "'s", "fine"]);
    // 第二段以 "'" 开头也不能并入上一段最后一个词
    expect(segmentRanges).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 6 },
    ]);
  });

  it("纯标点 token 被跳过，但 segmentRanges 与 segments 等长", () => {
    const transcript = wordLevelTranscript([
      { text: "Hi -- there", words: ["Hi", "--", "there"] },
      { text: "...", words: ["..."] },
    ]);
    const { refs, segmentRanges } = buildTokenUniverse(transcript);
    expect(refs.map((r) => r.raw)).toEqual(["Hi", "there"]);
    expect(segmentRanges).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 2 },
    ]);
  });

  it("段级降级：按 segment.text 分词，时间取 segment 区间", () => {
    const transcript: Transcript = {
      wordLevel: false,
      language: "en",
      segments: [{ id: 0, start: 1, end: 3, text: "I like apples." }],
    };
    const { refs } = buildTokenUniverse(transcript);
    expect(refs).toEqual([
      { raw: "I", norm: "i", start: 1, end: 3 },
      { raw: "like", norm: "like", start: 1, end: 3 },
      { raw: "apples.", norm: "apples", start: 1, end: 3 },
    ]);
  });
});

describe("sentenceWordView", () => {
  it("返回该句编号词表（原始拼写）与全局 ref 区间", () => {
    const transcript = wordLevelTranscript([
      { text: "It costs $10,000.", words: ["It", "costs", "$10,000."] },
      { text: "Fine", words: ["Fine"] },
    ]);
    const universe = buildTokenUniverse(transcript);
    expect(sentenceWordView(universe, 0)).toEqual({
      words: ["It", "costs", "$10,000."],
      wordStart: 0,
      wordEnd: 3,
    });
    expect(sentenceWordView(universe, 1)).toEqual({ words: ["Fine"], wordStart: 3, wordEnd: 4 });
  });

  it("空句返回 null（调用方跳过，不发起模型调用）", () => {
    const transcript = wordLevelTranscript([{ text: "...", words: ["..."] }]);
    const universe = buildTokenUniverse(transcript);
    expect(sentenceWordView(universe, 0)).toBeNull();
    expect(sentenceWordView(universe, 99)).toBeNull();
  });
});

describe("normalizeToken", () => {
  it("去掉标点并小写", () => {
    expect(normalizeToken("Don't")).toBe("dont");
    expect(normalizeToken("$10,000")).toBe("10000");
    expect(normalizeToken("...")).toBe("");
  });
});

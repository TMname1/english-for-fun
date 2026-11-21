import type { QwenAsrWord } from "../asr";
import { asrSegmentParts, buildTranscriptFromSentences } from "../asr";
import { callLlmJson } from "../llm";
import { mergeWordGroup, preprocessTranscript, validatePartition } from "../preprocess";

jest.mock("../llm", () => ({
  ...jest.requireActual("../llm"),
  callLlmJson: jest.fn(),
}));

const w = (text: string, begin_time: number, end_time: number, punctuation = ""): QwenAsrWord => ({
  text,
  begin_time,
  end_time,
  punctuation,
});

/** I've played Zelda. Genuinely fun. —— 含缩写碎片与拦腰拆词碎片 */
function fragmentFixture() {
  const words = [
    w("I", 0, 100),
    w("'", 100, 150),
    w("ve", 150, 300),
    w(" ", 300, 310), // 纯空格占位词，被过滤
    w(" played", 310, 600),
    w(" Zelda", 600, 900, "."),
    w(" ", 900, 910),
    w("Genu", 1000, 1100),
    w("inely", 1100, 1300),
    w(" fun", 1300, 1500, "."),
  ];
  const sent = {
    sentence_id: 1,
    begin_time: 0,
    end_time: 1500,
    text: "I've played Zelda. Genuinely fun.",
    sentence_end: true,
    words,
  };
  return { raw: [sent], transcript: buildTranscriptFromSentences([sent], "en") };
}

beforeEach(() => {
  jest.mocked(callLlmJson).mockReset();
});

describe("validatePartition", () => {
  it("升序连续不重不漏的分组合格", () => {
    expect(
      validatePartition(
        [
          [0, 1, 2],
          [3, 4],
        ],
        5,
      ),
    ).toBeNull();
    expect(validatePartition([[0]], 1)).toBeNull();
  });

  it("缺词 / 重复 / 乱序 / 空组 / 越界都不合格", () => {
    expect(validatePartition([[0, 2]], 3)).toMatch(/不重不漏/);
    expect(validatePartition([[0, 0, 1]], 2)).toMatch(/不重不漏/);
    expect(validatePartition([[1, 0]], 2)).toMatch(/不重不漏/);
    expect(validatePartition([[], [0]], 1)).toMatch(/为空/);
    expect(validatePartition([[0]], 2)).toMatch(/只覆盖了 1\/2/);
    expect(validatePartition([[0, 1, 2]], 2)).toMatch(/越界/);
  });
});

describe("mergeWordGroup", () => {
  it("attachToPrev 碎片无空格拼接，时间戳取原始词首尾", () => {
    const { raw } = fragmentFixture();
    const parts = asrSegmentParts(raw[0])!;
    const merged = mergeWordGroup(parts.words, [0, 1, 2, 3, 4]);
    expect(merged).toEqual([
      { word: "I've", start: 0, end: 0.3 },
      { word: "played", start: 0.31, end: 0.6 },
      { word: "Zelda.", start: 0.6, end: 0.9 },
    ]);
  });

  it("纯空格占位词后的无前导空格独立词不误并（a 不粘到 Hi.）", () => {
    const sent = {
      begin_time: 0,
      end_time: 400,
      text: "Hi. a goaded",
      sentence_end: true,
      words: [
        w("Hi", 0, 100, "."),
        w(" ", 100, 110),
        w("a", 110, 200),
        w(" go", 200, 300),
        w("aded", 300, 400),
      ],
    };
    const parts = asrSegmentParts(sent)!;
    expect(mergeWordGroup(parts.words, [0])).toEqual([{ word: "Hi.", start: 0, end: 0.1 }]);
    expect(mergeWordGroup(parts.words, [1, 2, 3])).toEqual([
      { word: "a", start: 0.11, end: 0.2 },
      { word: "goaded", start: 0.2, end: 0.4 },
    ]);
  });
});

describe("preprocessTranscript", () => {
  it("LLM 词序号分组 -> 完整句 segments：碎片合并、text=words.join、时间戳单调", async () => {
    const { raw, transcript } = fragmentFixture();
    jest.mocked(callLlmJson).mockResolvedValue({
      sentences: [
        [0, 1, 2, 3, 4],
        [5, 6, 7],
      ],
    });

    const out = await preprocessTranscript(transcript, raw);
    expect(out.wordLevel).toBe(true);
    expect(out.language).toBe("en");
    expect(out.segments).toHaveLength(2);

    expect(out.segments[0].text).toBe("I've played Zelda.");
    expect(out.segments[0].words!.map((x) => x.word)).toEqual(["I've", "played", "Zelda."]);
    expect(out.segments[0].start).toBe(0);
    expect(out.segments[0].end).toBeCloseTo(0.9);

    expect(out.segments[1].text).toBe("Genuinely fun.");
    expect(out.segments[1].words!.map((x) => x.word)).toEqual(["Genuinely", "fun."]);
    expect(out.segments[1].start).toBe(1);
    expect(out.segments[1].end).toBeCloseTo(1.5);

    for (const [i, seg] of out.segments.entries()) {
      expect(seg.id).toBe(i);
      expect(seg.text).toBe(seg.words!.map((x) => x.word).join(" "));
    }
    expect(callLlmJson).toHaveBeenCalledTimes(1);
  });

  it("分组不合格时重试一次，重试消息带上失败原因", async () => {
    const { raw, transcript } = fragmentFixture();
    jest
      .mocked(callLlmJson)
      .mockResolvedValueOnce({ sentences: [[0, 1]] }) // 缺词
      .mockResolvedValueOnce({ sentences: [[0, 1, 2, 3, 4, 5, 6, 7]] });

    const out = await preprocessTranscript(transcript, raw);
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0].text).toBe("I've played Zelda. Genuinely fun.");
    expect(callLlmJson).toHaveBeenCalledTimes(2);
    const retryMessages = jest.mocked(callLlmJson).mock.calls[1][0];
    expect(retryMessages[1].content).toContain("上一次输出不合格");
  });

  it("重试后仍不合格则整体抛错", async () => {
    const { raw, transcript } = fragmentFixture();
    jest.mocked(callLlmJson).mockResolvedValue({ sentences: [[0]] });
    await expect(preprocessTranscript(transcript, raw)).rejects.toThrow(/最终失败/);
    expect(callLlmJson).toHaveBeenCalledTimes(2);
  });

  it("结构不合法（非整数序号）同样走重试后失败", async () => {
    const { raw, transcript } = fragmentFixture();
    jest.mocked(callLlmJson).mockResolvedValue({ sentences: [["a", "b"]] });
    await expect(preprocessTranscript(transcript, raw)).rejects.toThrow(/最终失败/);
  });

  it("段级降级（无词时间戳）跳过 LLM 原样返回", async () => {
    const sent = { begin_time: 0, end_time: 2000, text: "Hello there.", sentence_end: true };
    const transcript = buildTranscriptFromSentences([sent], "en");
    const out = await preprocessTranscript(transcript, [sent]);
    expect(out).toBe(transcript);
    expect(callLlmJson).not.toHaveBeenCalled();
  });

  it("单词段跳过 LLM", async () => {
    const sent = {
      begin_time: 0,
      end_time: 500,
      text: "Hi.",
      sentence_end: true,
      words: [w("Hi", 0, 500, ".")],
    };
    const transcript = buildTranscriptFromSentences([sent], "en");
    const out = await preprocessTranscript(transcript, [sent]);
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0].text).toBe("Hi.");
    expect(callLlmJson).not.toHaveBeenCalled();
  });
});

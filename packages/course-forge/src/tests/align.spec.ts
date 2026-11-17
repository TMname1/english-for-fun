import { describe, expect, it } from "vitest";

import type { DraftStatement, Transcript } from "../types";
import { alignStatements, formatAlignmentSummary, normalizeToken } from "../align";

/** 构造词级 transcript：words 按 0.5s 一词均匀排布，每个 segment 一个完整句 */
function wordTranscript(segments: Array<{ text: string }>): Transcript {
  let t = 0;
  return {
    wordLevel: true,
    language: "en",
    segments: segments.map((seg, id) => {
      const words = seg.text
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => {
          const start = t;
          t += 0.5;
          return { word: w, start, end: t };
        });
      const start = words[0]?.start ?? t;
      const end = words[words.length - 1]?.end ?? t;
      return { id, start, end, text: seg.text, words };
    }),
  };
}

function stmt(english: string): DraftStatement {
  return { english, chinese: "中文" };
}

describe("normalizeToken", () => {
  it("去掉标点并小写", () => {
    expect(normalizeToken("Don't")).toBe("dont");
    expect(normalizeToken("T-shirt,")).toBe("tshirt");
    expect(normalizeToken("...")).toBe("");
  });
});

describe("alignStatements", () => {
  it("锚点句拿到整句时间与逐词时间戳", () => {
    const transcript = wordTranscript([{ text: "I like apples." }, { text: "You like pears." }]);
    const { timings, report } = alignStatements(transcript, [stmt("I like apples")]);
    expect(timings[0]).not.toBeNull();
    expect(timings[0]!.startTime).toBe(0);
    expect(timings[0]!.endTime).toBe(1.5);
    expect(timings[0]!.words).toEqual([
      { word: "I", start: 0, end: 0.5 },
      { word: "like", start: 0.5, end: 1 },
      { word: "apples", start: 1, end: 1.5 },
    ]);
    expect(report.entries[0].kind).toBe("anchor");
  });

  it("单词与短语碎片落在所属句子区间内", () => {
    const transcript = wordTranscript([
      { text: "Hello world." },
      { text: "I like apples." },
      { text: "Goodbye." },
    ]);
    const statements = [
      stmt("Hello world"),
      stmt("I"),
      stmt("like"),
      stmt("I like"),
      stmt("I like apples"),
      stmt("Goodbye"),
    ];
    const { timings } = alignStatements(transcript, statements);
    expect(timings[1]!.startTime).toBe(1); // "I" 是第二句首词
    expect(timings[1]!.endTime).toBe(1.5);
    expect(timings[3]!.startTime).toBe(1); // "I like"
    expect(timings[3]!.endTime).toBe(2);
    expect(timings[4]!.startTime).toBe(1); // 锚点句 "I like apples"
    expect(timings[4]!.endTime).toBe(2.5);
  });

  it("重复碎片按目标锚点句消歧（副歌场景）", () => {
    const transcript = wordTranscript([
      { text: "I like apples." },
      { text: "You like pears." },
      { text: "I like apples." },
    ]);
    const statements = [
      stmt("I like apples"),
      stmt("You like pears"),
      stmt("I"),
      stmt("I like apples"),
    ];
    const { timings } = alignStatements(transcript, statements);
    expect(timings[0]!.startTime).toBe(0); // 第一次出现
    expect(timings[2]!.startTime).toBe(3); // 碎片 "I" 落到第二次出现的句子里
    expect(timings[3]!.startTime).toBe(3); // 锚点单调对齐到第二次出现
  });

  it("预处理后一个 segment 即一个完整句：各段独立成锚点，不再跨段拼句", () => {
    const transcript = wordTranscript([{ text: "I like" }, { text: "apples very much." }]);
    const { timings, report } = alignStatements(transcript, [
      stmt("I like"),
      stmt("apples very much"),
    ]);
    expect(report.entries[0].kind).toBe("anchor");
    expect(report.entries[1].kind).toBe("anchor");
    expect(timings[0]!.startTime).toBe(0);
    expect(timings[0]!.endTime).toBe(1);
    expect(timings[1]!.startTime).toBe(1);
    expect(timings[1]!.endTime).toBe(2.5);
  });

  it("whisper 撇号粘连切分（don + 't）合并后匹配", () => {
    const transcript = wordTranscript([{ text: "I don 't like it." }]);
    const { timings } = alignStatements(transcript, [stmt("don't")]);
    expect(timings[0]).not.toBeNull();
    expect(timings[0]!.startTime).toBe(0.5);
    expect(timings[0]!.endTime).toBe(1.5);
  });

  it("模糊匹配仅在候选唯一时采信", () => {
    // 转写识别错了一个词（applez），statement 是正确拼写
    const transcript = wordTranscript([{ text: "I like applez very much." }]);
    const { timings, report } = alignStatements(transcript, [stmt("I like apples very much")]);
    expect(timings[0]).not.toBeNull();
    expect(report.entries[0].kind).toBe("fuzzy");
    expect(timings[0]!.startTime).toBe(0);
    expect(timings[0]!.endTime).toBe(2.5);
  });

  it("无法匹配的 statement 置 null 且计入 failed", () => {
    const transcript = wordTranscript([{ text: "I like apples." }]);
    const { timings, report } = alignStatements(transcript, [
      stmt("completely different words here"),
    ]);
    expect(timings[0]).toBeNull();
    expect(report.failed).toBe(1);
    expect(report.entries[0].kind).toBe("failed");
  });

  it("段级降级模式：时间取 segment 区间，words 为 null", () => {
    const transcript: Transcript = {
      wordLevel: false,
      language: "en",
      segments: [
        { id: 0, start: 0, end: 2, text: "I like apples." },
        { id: 1, start: 2, end: 4, text: "You like pears." },
      ],
    };
    const { timings } = alignStatements(transcript, [stmt("I like apples"), stmt("You like")]);
    expect(timings[0]).toEqual({ startTime: 0, endTime: 2, words: null });
    expect(timings[1]).toEqual({ startTime: 2, endTime: 4, words: null });
  });

  it("报告统计与摘要格式", () => {
    const transcript = wordTranscript([{ text: "I like apples." }]);
    const { report } = alignStatements(transcript, [stmt("I like apples"), stmt("no match here")]);
    expect(report.total).toBe(2);
    expect(report.exact).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.rate).toBe(0.5);
    expect(formatAlignmentSummary(report)).toContain("1/2");
  });
});

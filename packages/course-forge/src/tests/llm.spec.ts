import { describe, expect, it } from "vitest";

import type { DraftCourse, DraftStatement, Transcript, TranscriptSegment } from "../types";
import {
  buildChatBody,
  chunkTranscript,
  classifyLlmFailure,
  coerceCourseOutput,
  collectSseContent,
  draftSchema,
  evaluateCourseQuality,
  extractJsonObject,
  mergeSegments,
  messagesWithJsonKeyword,
  normalizeStatementsEnglish,
  stripEnglishPunctuation,
} from "../llm";

describe("extractJsonObject", () => {
  it("parses plain json", () => {
    expect(extractJsonObject(`{"a":1}`)).toEqual({ a: 1 });
  });

  it("parses fenced json with leading prose", () => {
    const text = `Here you go:\n\`\`\`json\n{"courses":[]}\n\`\`\`\nHope that helps.`;
    expect(extractJsonObject(text)).toEqual({ courses: [] });
  });

  it("tracks braces inside strings", () => {
    const text = `prefix {"english":"a{b}c","x":{"y":1}} suffix`;
    expect(extractJsonObject(text)).toEqual({ english: "a{b}c", x: { y: 1 } });
  });

  it("throws on incomplete json", () => {
    expect(() => extractJsonObject(`{"a":`)).toThrow();
    expect(() => extractJsonObject(`no json here`)).toThrow();
  });
});

describe("draftSchema", () => {
  const ok = {
    title: "T",
    description: "",
    statements: [{ english: "I", chinese: "我", phonetic: "/aɪ/" }],
  };

  it("accepts a single course object", () => {
    expect(draftSchema.safeParse(ok).success).toBe(true);
  });

  it("rejects missing chinese / empty statements / wrapped courses array", () => {
    expect(draftSchema.safeParse({ title: "T", statements: [{ english: "I" }] }).success).toBe(
      false,
    );
    expect(draftSchema.safeParse({ title: "T", statements: [] }).success).toBe(false);
    expect(draftSchema.safeParse({ courses: [ok] }).success).toBe(false);
  });
});

describe("coerceCourseOutput", () => {
  const course = { title: "T", statements: [{ english: "I", chinese: "我" }] };

  it('unwraps a legacy {"courses":[...]} envelope to the first course', () => {
    expect(coerceCourseOutput({ courses: [course] })).toEqual(course);
  });

  it("passes a single course object through unchanged", () => {
    expect(coerceCourseOutput(course)).toBe(course);
  });
});

describe("stripEnglishPunctuation", () => {
  it("去掉句读标点并折叠多余空格", () => {
    expect(stripEnglishPunctuation("I like the food.")).toBe("I like the food");
    expect(stripEnglishPunctuation('  "Hi there!"  ')).toBe("Hi there");
    expect(stripEnglishPunctuation("well, actually... yes")).toBe("well actually yes");
  });

  it("保留撇号（直/弯）与连字符", () => {
    expect(stripEnglishPunctuation("don't like")).toBe("don't like");
    expect(stripEnglishPunctuation("don’t like!")).toBe("don’t like");
    expect(stripEnglishPunctuation("a well-known t-shirt")).toBe("a well-known t-shirt");
  });

  it("chinese 式全角标点同样从 english 中剥除", () => {
    expect(stripEnglishPunctuation("I like the food。")).toBe("I like the food");
  });
});

describe("normalizeStatementsEnglish", () => {
  it("就地清理 english 并返回变更清单", () => {
    const statements: DraftStatement[] = [
      { english: "I", chinese: "我" },
      { english: "I like the food.", chinese: "我喜欢这个食物。" },
    ];
    const { changes, emptyIndexes } = normalizeStatementsEnglish(statements);
    expect(statements[1].english).toBe("I like the food");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain("I like the food");
    expect(emptyIndexes).toEqual([]);
    // chinese 的标点不受影响
    expect(statements[1].chinese).toBe("我喜欢这个食物。");
  });

  it("整行只有标点时记入 emptyIndexes", () => {
    const statements: DraftStatement[] = [{ english: "...", chinese: "……" }];
    expect(normalizeStatementsEnglish(statements).emptyIndexes).toEqual([1]);
  });
});

describe("chunkTranscript", () => {
  function makeTranscript(wordsPerSeg: number, segs: number): Transcript {
    return {
      wordLevel: true,
      language: "en",
      segments: Array.from({ length: segs }, (_, i) => ({
        id: i,
        start: i * 2,
        end: i * 2 + 1.9,
        text: "a b",
        words: Array.from({ length: wordsPerSeg }, (_, k) => ({
          word: `w${k}`,
          start: i * 2 + k * 0.1,
          end: i * 2 + k * 0.1 + 0.05,
        })),
      })),
    };
  }

  it("keeps everything in one chunk under the limit", () => {
    const chunks = chunkTranscript(makeTranscript(10, 5), 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].segments).toHaveLength(5);
  });

  it("splits on word budget and preserves order/ids", () => {
    const chunks = chunkTranscript(makeTranscript(10, 5), 25);
    expect(chunks.length).toBeGreaterThan(1);
    const flat = chunks.flatMap((c) => c.segments.map((s) => s.id));
    expect(flat).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("mergeSegments", () => {
  const seg = (id: number, text: string): TranscriptSegment => ({
    id,
    start: id,
    end: id + 0.9,
    text,
  });

  it("拼接碎片直到句末标点，id 取该句首个碎片", () => {
    const out = mergeSegments([
      seg(
        0,
        "I know a lot of guys have trouble picking up on the signs of whether or not a girl is",
      ),
      seg(1, "into them, so today I want to do a little quiz."),
      seg(2, "Okay."),
    ]);
    expect(out.map((s) => s.text)).toEqual([
      "I know a lot of guys have trouble picking up on the signs of whether or not a girl is into them, so today I want to do a little quiz.",
      "Okay.",
    ]);
    expect(out[0].id).toBe(0);
    expect(out[1].id).toBe(2);
    expect(out[1].end).toBeCloseTo(2.9);
  });

  it("引号收尾的句子照常断句", () => {
    const out = mergeSegments([
      seg(0, "she says, wow, do you think you could"),
      seg(1, 'give me a hand?"'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].text.endsWith('hand?"')).toBe(true);
  });

  it("超长无句末的碎片保留为完整一句，不再按词数强制断开", () => {
    const words = Array.from({ length: 42 }, (_, i) => `w${i}`);
    const out = mergeSegments([
      seg(0, `${words.slice(0, 22).join(" ")},`),
      seg(1, words.slice(22).join(" ")),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe(`${words.slice(0, 22).join(" ")}, ${words.slice(22).join(" ")}`);
    expect(out[0].text.split(/\s+/).filter(Boolean).length).toBe(42);
  });

  it("末尾未闭合文本照常输出，空文本段跳过", () => {
    expect(mergeSegments([seg(0, "trailing words without end punctuation")])).toHaveLength(1);
    expect(mergeSegments([seg(0, "   "), seg(1, "Hi.")])).toHaveLength(1);
  });
});

describe("evaluateCourseQuality", () => {
  const course = (lines: string[]): DraftCourse => ({
    title: "t",
    statements: lines.map((english) => ({ english, chinese: "译" })),
  });

  it("正常逐级组装课通过", () => {
    const c = course([
      "I",
      "like",
      "food",
      "today",
      "I like the food",
      "I like the food today",
      "she",
      "she likes him a lot",
      "she likes him a lot today",
    ]);
    expect(evaluateCourseQuality(c, 5).ok).toBe(true);
  });

  it("单词列表课（qwen3:4b 第 2/3 分块的劣化形态）拒绝", () => {
    const c = course([
      "And",
      "then",
      "after",
      "five",
      "minutes",
      "she",
      "looks",
      "back",
      "says",
      "wow",
      "sweaty",
      "already",
    ]);
    const v = evaluateCourseQuality(c, 12);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.problems.join()).toMatch(/单词/);
  });

  it("只有短语、没有完整句拒绝", () => {
    const v = evaluateCourseQuality(course(["a b c", "d e f", "g h i", "j k l"]), 6);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.problems.join()).toMatch(/完整句/);
  });

  it("空课程拒绝", () => {
    expect(evaluateCourseQuality({ title: "t", statements: [] }, 3).ok).toBe(false);
  });
});

const ev = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

describe("buildChatBody", () => {
  const base = { model: "m", maxTokens: 100, messages: [{ role: "user" as const, content: "hi" }] };

  it("streams and includes reasoning_effort when configured", () => {
    const body = buildChatBody({ ...base, reasoningEffort: "none" });
    expect(body.stream).toBe(true);
    expect(body.reasoning_effort).toBe("none");
    expect(body.response_format).toBeUndefined();
  });

  it("omits reasoning_effort when config is empty, includes response_format when given", () => {
    const body = buildChatBody({
      ...base,
      reasoningEffort: "",
      responseFormat: { type: "json_object" },
    });
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.response_format).toEqual({ type: "json_object" });
  });
});

describe("collectSseContent", () => {
  it("accumulates content deltas until [DONE]", () => {
    const text =
      ev({ choices: [{ delta: { content: "{" } }] }) +
      ": keepalive\n" +
      ev({ choices: [{ delta: { content: '"a":1}' } }] }) +
      "data: [DONE]\n\n";
    expect(collectSseContent(text)).toEqual({ content: '{"a":1}', done: true, error: null });
  });

  it("ignores reasoning deltas and handles CRLF", () => {
    const text =
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning: "lot of thoughts", content: "x" } }] })}\r\n\r\n` +
      `data: ${JSON.stringify({ choices: [{ delta: { content: "y" } }] })}\r\n\r\n` +
      "data: [DONE]\r\n";
    expect(collectSseContent(text)).toEqual({ content: "xy", done: true, error: null });
  });

  it("supports message-style final chunk (non-delta providers)", () => {
    const text = ev({ choices: [{ message: { content: "full" } }] }) + "data: [DONE]\n\n";
    expect(collectSseContent(text).content).toBe("full");
  });

  it("extracts error payloads (string or object form)", () => {
    expect(collectSseContent(ev({ error: "boom" })).error).toBe("boom");
    expect(collectSseContent(ev({ error: { message: "cuda oom" } })).error).toBe("cuda oom");
  });

  it("no [DONE] when stream truncated", () => {
    const r = collectSseContent(ev({ choices: [{ delta: { content: "half" } }] }));
    expect(r).toEqual({ content: "half", done: false, error: null });
  });
});

describe("classifyLlmFailure", () => {
  const fetchFailed = (cause: unknown) => Object.assign(new TypeError("fetch failed"), { cause });

  it("timeout via undici HeadersTimeoutError cause", () => {
    const e = fetchFailed(new Error("Headers Timeout Error") as any & { name: string });
    (e.cause as any).name = "HeadersTimeoutError";
    expect(classifyLlmFailure(e).kind).toBe("timeout");
  });

  it("timeout via AbortSignal TimeoutError (DOMException shape)", () => {
    const e = Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });
    expect(classifyLlmFailure(e).kind).toBe("timeout");
  });

  it("unreachable via ECONNREFUSED cause", () => {
    const e = fetchFailed(
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" }),
    );
    expect(classifyLlmFailure(e).kind).toBe("unreachable");
  });

  it("network via socket reset cause", () => {
    const e = fetchFailed(Object.assign(new Error("other side closed"), { code: "ECONNRESET" }));
    expect(classifyLlmFailure(e).kind).toBe("network");
  });

  it("application HTTP error is other (fallback ladder continues)", () => {
    expect(classifyLlmFailure(new Error("LLM HTTP 400: bad response_format")).kind).toBe("other");
    expect(classifyLlmFailure(new Error("LLM 输出中未找到 JSON: oops"))).toEqual({
      kind: "other",
      detail: "Error  LLM 输出中未找到 JSON: oops",
    });
  });

  it("cloud moderation via SSE payload or DataInspectionFailed 400 is moderation", () => {
    expect(
      classifyLlmFailure(
        new Error("LLM 流式生成中断: Output data may contain inappropriate content."),
      ).kind,
    ).toBe("moderation");
    expect(
      classifyLlmFailure(
        new Error('LLM HTTP 400: {"error":{"code":"data_inspection_failed","message":"..."}}'),
      ).kind,
    ).toBe("moderation");
  });
});

describe("messagesWithJsonKeyword", () => {
  const msgs = [
    { role: "system" as const, content: "你是命题专家" },
    { role: "user" as const, content: "编排 statement 链" },
  ];

  it("json_object 分支补含 JSON 一词的消息，原数组不动", () => {
    const out = messagesWithJsonKeyword(msgs, { type: "json_object" });
    expect(out).toHaveLength(3);
    expect(out[2].content.toLowerCase()).toContain("json");
    expect(msgs).toHaveLength(2);
  });

  it("json_schema 与纯文本分支原样返回", () => {
    expect(messagesWithJsonKeyword(msgs, { type: "json_schema", json_schema: {} })).toBe(msgs);
    expect(messagesWithJsonKeyword(msgs, undefined)).toBe(msgs);
  });
});

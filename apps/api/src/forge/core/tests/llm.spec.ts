import type { DraftStatement } from "../types";
import {
  buildChatBody,
  classifyLlmFailure,
  coerceCourseOutput,
  collectSseContent,
  containsFullSentence,
  draftSchema,
  extractJsonObject,
  mapWithConcurrency,
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
  it("接受只含 statements 的单句组装链", () => {
    expect(
      draftSchema.safeParse({
        statements: [{ english: "I", chinese: "我", phonetic: "/aɪ/" }],
      }).success,
    ).toBe(true);
  });

  it("拒绝缺 chinese / 空 statements / 缺 statements", () => {
    expect(draftSchema.safeParse({ statements: [{ english: "I" }] }).success).toBe(false);
    expect(draftSchema.safeParse({ statements: [] }).success).toBe(false);
    expect(draftSchema.safeParse({}).success).toBe(false);
  });
});

describe("containsFullSentence", () => {
  const chain = (lines: string[]): DraftStatement[] =>
    lines.map((english) => ({ english, chinese: "译" }));

  it("链里有逐字等于原句的行（忽略大小写/标点）判定为存在", () => {
    expect(containsFullSentence(chain(["I", "like", "I like the food."]), "I like the food!")).toBe(
      true,
    );
  });

  it("缩写被展开判为不存在（don't -> do not 失配）", () => {
    expect(containsFullSentence(chain(["I", "do not like it"]), "I don't like it.")).toBe(false);
  });

  it("漏词 / 完全没有完整行判为不存在", () => {
    expect(containsFullSentence(chain(["I", "like", "the food"]), "I like the food.")).toBe(false);
  });

  it("空原句不存在", () => {
    expect(containsFullSentence(chain(["I"]), "   ")).toBe(false);
  });
});

describe("mapWithConcurrency", () => {
  it("按输入顺序返回结果", async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it("并发上限被遵守", async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 12 }, (_, i) => i),
      3,
      async (n) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5 + (n % 3)));
        active--;
        return n;
      },
    );
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("任一任务失败即整体 reject", async () => {
    await expect(
      mapWithConcurrency([0, 1, 2], 2, async (n) => {
        if (n === 1) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
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

  it("includes enable_thinking when explicitly set (false or true)", () => {
    expect(
      buildChatBody({ ...base, reasoningEffort: "", enableThinking: false }).enable_thinking,
    ).toBe(false);
    expect(
      buildChatBody({ ...base, reasoningEffort: "", enableThinking: true }).enable_thinking,
    ).toBe(true);
  });

  it("omits enable_thinking when not configured", () => {
    const body = buildChatBody({ ...base, reasoningEffort: "" });
    expect("enable_thinking" in body).toBe(false);
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

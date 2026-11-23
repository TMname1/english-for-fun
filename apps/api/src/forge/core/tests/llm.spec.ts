import {
  buildChatBody,
  buildEnglishFromIndexes,
  classifyLlmFailure,
  cleanWordToken,
  coerceCourseOutput,
  collectSseContent,
  draftRowsSchema,
  extractJsonObject,
  mapWithConcurrency,
  messagesWithJsonKeyword,
  rowsToStatements,
  stripSingleWordRows,
  validateRowIndexes,
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

describe("draftRowsSchema", () => {
  it("接受只含编号的行", () => {
    expect(
      draftRowsSchema.safeParse({
        statements: [{ indexes: [0, 1], chinese: "我喜欢", phonetic: "/aɪ/ /laɪk/" }],
      }).success,
    ).toBe(true);
  });

  it("拒绝字符串编号 / 空编号 / 缺 chinese / 空 statements", () => {
    const base = { statements: [{ indexes: ["I", "like"], chinese: "我喜欢" }] };
    expect(draftRowsSchema.safeParse(base).success).toBe(false);
    expect(
      draftRowsSchema.safeParse({ statements: [{ indexes: [], chinese: "我" }] }).success,
    ).toBe(false);
    expect(draftRowsSchema.safeParse({ statements: [{ indexes: [0] }] }).success).toBe(false);
    expect(draftRowsSchema.safeParse({ statements: [] }).success).toBe(false);
    expect(draftRowsSchema.safeParse({}).success).toBe(false);
  });
});

describe("cleanWordToken", () => {
  it("逐词删标点，不把一个词拆成两个 token", () => {
    expect(cleanWordToken("$10,000")).toBe("10000");
    expect(cleanWordToken("food.")).toBe("food");
    expect(cleanWordToken("U.S.")).toBe("US");
    expect(cleanWordToken("10:30")).toBe("1030");
    expect(cleanWordToken("“Hi”")).toBe("Hi");
  });

  it("保留撇号（直/弯）与连字符", () => {
    expect(cleanWordToken("don't")).toBe("don't");
    expect(cleanWordToken("don’t")).toBe("don’t");
    expect(cleanWordToken("well-known")).toBe("well-known");
  });
});

describe("buildEnglishFromIndexes", () => {
  // 纯标点词不会进编号词表（buildTokenUniverse 已过滤），所以这里只有 3 个词
  const words = ["It", "costs", "$10,000"];

  it("按编号还原，token 数 === 编号数（$10,000 仍是 1 个词）", () => {
    const english = buildEnglishFromIndexes([0, 1, 2], words);
    expect(english).toBe("It costs 10000");
    expect(english.split(" ")).toHaveLength(3);
  });

  it("碎片行只拼该片段的词", () => {
    expect(buildEnglishFromIndexes([1, 2], words)).toBe("costs 10000");
  });
});

describe("validateRowIndexes", () => {
  it("合法链：升序连续且有一行覆盖整句", () => {
    expect(
      validateRowIndexes(
        [
          [2, 3],
          [0, 1],
          [0, 1, 2, 3],
        ],
        4,
      ),
    ).toBeNull();
  });

  it("空行 / 越界 / 跳号 / 倒序 都被拒", () => {
    expect(validateRowIndexes([[]], 4)).toContain("没有任何词编号");
    expect(validateRowIndexes([[0, 1, 2, 3], [4]], 4)).toContain("越界");
    expect(
      validateRowIndexes(
        [
          [0, 2],
          [0, 1, 2, 3],
        ],
        4,
      ),
    ).toContain("升序连续");
    expect(
      validateRowIndexes(
        [
          [2, 1],
          [0, 1, 2, 3],
        ],
        4,
      ),
    ).toContain("升序连续");
  });

  it("缺少整句行要报出来", () => {
    const reason = validateRowIndexes(
      [
        [0, 1],
        [2, 3],
      ],
      4,
    );
    expect(reason).toContain("没有任何一行恰好覆盖");
    expect(reason).toContain("0,1,…,3");
  });

  it("单词成行被拒（N>1）", () => {
    const reason = validateRowIndexes([[0], [1], [2, 3], [0, 1, 2, 3]], 4);
    expect(reason).toContain("只有一个词");
    expect(reason).toContain("逐词成行");
    // 定位到第一个违规行（第 1 行）
    expect(reason).toContain("第 1 行");
  });

  it("N===1 的整句行 [0] 放行", () => {
    expect(validateRowIndexes([[0]], 1)).toBeNull();
  });

  it("越界判定优先于单词成行（文案不回归）", () => {
    expect(validateRowIndexes([[0, 1, 2, 3], [4]], 4)).toContain("越界");
  });

  it("编号从 0 开始的提示出现在越界文案里", () => {
    expect(validateRowIndexes([[0, 1, 2, 3, 4]], 4)).toContain("编号从 0 开始");
  });
});

describe("rowsToStatements", () => {
  const words = ["I", "like", "the", "food."];

  it("english 由编号还原，越界行被跳过", () => {
    const statements = rowsToStatements(
      [
        { indexes: [0, 1], chinese: "我喜欢", phonetic: "/aɪ/ /laɪk/" },
        { indexes: [0, 9], chinese: "坏行" },
      ],
      words,
    );
    expect(statements).toEqual([{ english: "I like", chinese: "我喜欢", phonetic: "/aɪ/ /laɪk/" }]);
  });
});

describe("stripSingleWordRows", () => {
  const words = ["I", "like", "the", "food."];
  const raw = (rows: unknown) => JSON.stringify({ statements: rows });

  it("删掉单词行后合格：english 由编号还原、span 相对本句词起点", () => {
    const result = stripSingleWordRows(
      raw([
        { indexes: [0], chinese: "我", phonetic: "/aɪ/" },
        { indexes: [1], chinese: "喜欢", phonetic: "/laɪk/" },
        { indexes: [0, 1], chinese: "我喜欢", phonetic: "/aɪ/ /laɪk/" },
        { indexes: [2, 3], chinese: "这个食物" },
        { indexes: [0, 1, 2, 3], chinese: "我喜欢这个食物" },
      ]),
      10,
      words,
    );
    expect(result.removed).toBe(2);
    expect(result.reason).toBeNull();
    expect(result.chain?.statements.map((s) => s.english)).toEqual([
      "I like",
      "the food",
      "I like the food",
    ]);
    expect(result.chain?.spans).toEqual([
      { wordStart: 10, wordEnd: 12 },
      { wordStart: 12, wordEnd: 14 },
      { wordStart: 10, wordEnd: 14 },
    ]);
  });

  it("删完仍缺整句行：不合格并给出原因 + 剩余行快照", () => {
    const result = stripSingleWordRows(
      raw([
        { indexes: [0], chinese: "我" },
        { indexes: [0, 1], chinese: "我喜欢" },
        { indexes: [2, 3], chinese: "这个食物" },
      ]),
      0,
      words,
    );
    expect(result.removed).toBe(1);
    expect(result.chain).toBeNull();
    expect(result.reason).toContain("没有任何一行恰好覆盖");
    expect(result.statements?.map((s) => s.english)).toEqual(["I like", "the food"]);
  });

  it("没有单词行时明确告知无需删除", () => {
    const result = stripSingleWordRows(raw([{ indexes: [0, 1, 2, 3], chinese: "整句" }]), 0, words);
    expect(result.removed).toBe(0);
    expect(result.chain).toBeNull();
    expect(result.reason).toContain("没有单词成行");
  });

  it("本句只有 1 个词时整句行 [0] 不算单词行", () => {
    const result = stripSingleWordRows(raw([{ indexes: [0], chinese: "嗯" }]), 0, ["Oh"]);
    expect(result.removed).toBe(0);
    expect(result.chain).toBeNull();
    expect(result.reason).toContain("没有单词成行");
  });

  it("raw 解析不出编号时提示改用重试或删除", () => {
    for (const bad of [null, "", "not json", JSON.stringify({ statements: [] })]) {
      const result = stripSingleWordRows(bad, 0, words);
      expect(result.removed).toBe(0);
      expect(result.chain).toBeNull();
      expect(result.reason).toContain("请改用「重试该句」或「删除该句」");
    }
  });

  it('兼容 {"courses":[...]} 旧包裹', () => {
    const result = stripSingleWordRows(
      JSON.stringify({
        courses: [
          {
            statements: [
              { indexes: [2], chinese: "这个" },
              { indexes: [0, 1, 2, 3], chinese: "整句" },
            ],
          },
        ],
      }),
      0,
      words,
    );
    expect(result.removed).toBe(1);
    expect(result.chain?.statements.map((s) => s.english)).toEqual(["I like the food"]);
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

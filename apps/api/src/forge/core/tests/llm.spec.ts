import {
  autoStripSingleWordRows,
  buildEnglishFromIndexes,
  buildModelKwargs,
  classifyLlmFailure,
  cleanWordToken,
  coerceCourseOutput,
  draftRowsSchema,
  extractJsonObject,
  mapWithConcurrency,
  messagesWithJsonKeyword,
  overrideFullRowChinese,
  rowsToStatements,
  stripSingleWordRows,
  validateRowIndexes,
} from "../llm";
import { buildMessages } from "../prompt";

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

describe("autoStripSingleWordRows", () => {
  const words = ["I", "like", "the", "food."];
  const raw = (rows: unknown) => JSON.stringify({ statements: rows });

  it("输出混着单词行：删掉后合格，直接给可用组装链、不给失败快照", () => {
    const out = autoStripSingleWordRows(
      raw([
        { indexes: [0], chinese: "我" },
        { indexes: [1], chinese: "喜欢" },
        { indexes: [0, 1], chinese: "我喜欢" },
        { indexes: [0, 1, 2, 3], chinese: "我喜欢这个食物" },
      ]),
      5,
      words,
    );
    expect(out?.removed).toBe(2);
    expect(out?.chain?.statements.map((s) => s.english)).toEqual(["I like", "I like the food"]);
    expect(out?.chain?.spans).toEqual([
      { wordStart: 5, wordEnd: 7 },
      { wordStart: 5, wordEnd: 9 },
    ]);
    expect(out?.attempt).toBeNull();
  });

  it("删完仍不合规：给带 autoStrip 标记的失败快照（交给用户）", () => {
    const out = autoStripSingleWordRows(
      raw([
        { indexes: [0], chinese: "我" },
        { indexes: [0, 1], chinese: "我喜欢" },
        { indexes: [2, 3], chinese: "这个食物" },
      ]),
      0,
      words,
    );
    expect(out?.chain).toBeNull();
    expect(out?.attempt?.autoStrip).toBe(true);
    expect(out?.attempt?.reason).toContain("已自动删除 1 个单词行");
    expect(out?.attempt?.reason).toContain("没有任何一行恰好覆盖");
    expect(out?.attempt?.statements?.map((s) => s.english)).toEqual(["I like", "the food"]);
  });

  it("与失败原因无关：越界等原因只要输出混着单词行，同样先删一遍", () => {
    const out = autoStripSingleWordRows(
      raw([
        { indexes: [0], chinese: "我" },
        { indexes: [1, 2], chinese: "喜欢这个" },
        { indexes: [3, 4], chinese: "食物" },
      ]),
      0,
      words,
    );
    expect(out?.removed).toBe(1);
    expect(out?.chain).toBeNull();
    expect(out?.attempt?.autoStrip).toBe(true);
    expect(out?.attempt?.reason).toContain("越界");
  });

  it("输出里没有单词行时完全不动（返回 null，保留原失败原因）", () => {
    expect(
      autoStripSingleWordRows(
        raw([
          { indexes: [0, 1], chinese: "我喜欢" },
          { indexes: [2, 3], chinese: "这个食物" },
        ]),
        0,
        words,
      ),
    ).toBeNull();
  });

  it("原始输出解析不出编号时完全不动", () => {
    expect(autoStripSingleWordRows("not json", 0, words)).toBeNull();
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

describe("buildModelKwargs", () => {
  it("reasoning_effort 有值才发送（空串表示不发送）", () => {
    expect(buildModelKwargs({ reasoningEffort: "none" }).reasoning_effort).toBe("none");
    expect("reasoning_effort" in buildModelKwargs({ reasoningEffort: "" })).toBe(false);
  });

  it("enable_thinking 显式设置（false / true）才发送", () => {
    expect(buildModelKwargs({ reasoningEffort: "", enableThinking: false }).enable_thinking).toBe(
      false,
    );
    expect(buildModelKwargs({ reasoningEffort: "", enableThinking: true }).enable_thinking).toBe(
      true,
    );
    expect("enable_thinking" in buildModelKwargs({ reasoningEffort: "" })).toBe(false);
  });

  it("response_format 按需透传（json_object 降级档位用）", () => {
    expect(
      buildModelKwargs({ reasoningEffort: "", responseFormat: { type: "json_object" } })
        .response_format,
    ).toEqual({ type: "json_object" });
    expect("response_format" in buildModelKwargs({ reasoningEffort: "" })).toBe(false);
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

describe("overrideFullRowChinese", () => {
  const rows = (): { indexes: number[]; chinese: string }[] => [
    { indexes: [0, 1], chinese: "我喜欢" },
    { indexes: [2, 3], chinese: "这个食物" },
    { indexes: [0, 1, 2, 3], chinese: "模型自己译的整句" },
  ];

  it("整句行被权威中文覆盖，碎片行不动", () => {
    const out = overrideFullRowChinese(rows(), 4, "我喜欢这个食物。");
    expect(out.map((r) => r.chinese)).toEqual(["我喜欢", "这个食物", "我喜欢这个食物。"]);
  });

  it("重复的整句行全部覆盖（校验不禁止重复）", () => {
    const out = overrideFullRowChinese(
      [
        { indexes: [0, 1, 2, 3], chinese: "a" },
        { indexes: [0, 1, 2, 3], chinese: "b" },
      ],
      4,
      "权威译文",
    );
    expect(out.map((r) => r.chinese)).toEqual(["权威译文", "权威译文"]);
  });

  it("无整句行 / 无参 / 空白串：原样返回", () => {
    expect(overrideFullRowChinese([{ indexes: [0, 1], chinese: "我喜欢" }], 4, "整句")).toEqual([
      { indexes: [0, 1], chinese: "我喜欢" },
    ]);
    expect(overrideFullRowChinese(rows(), 4, undefined)[2].chinese).toBe("模型自己译的整句");
    expect(overrideFullRowChinese(rows(), 4, "   ")[2].chinese).toBe("模型自己译的整句");
  });

  it("stripSingleWordRows 带句级中文：删单词行后整句行仍是权威中文", () => {
    const raw = JSON.stringify({
      statements: [
        { indexes: [0], chinese: "我" },
        { indexes: [0, 1, 2, 3], chinese: "模型译的整句" },
      ],
    });
    const result = stripSingleWordRows(raw, 0, ["I", "like", "the", "food"], "我喜欢这个食物。");
    expect(result.chain).not.toBeNull();
    const last = result.chain!.statements[result.chain!.statements.length - 1];
    expect(last.chinese).toBe("我喜欢这个食物。");
  });

  it("autoStripSingleWordRows 带句级中文：自动补救后的整句行同样是权威中文", () => {
    const raw = JSON.stringify({
      statements: [
        { indexes: [0], chinese: "我" },
        { indexes: [1], chinese: "喜欢" },
        { indexes: [0, 1, 2, 3], chinese: "模型译的整句" },
      ],
    });
    const out = autoStripSingleWordRows(raw, 0, ["I", "like", "the", "food"], "我喜欢这个食物。");
    const statements = out!.chain!.statements;
    expect(statements[statements.length - 1].chinese).toBe("我喜欢这个食物。");
  });
});

describe("buildMessages 权威中文", () => {
  const words = ["I", "like", "the", "food."];

  it("给了句级中文：user 消息带上【本句权威中文】与使用规则", () => {
    const [, user] = buildMessages(words, undefined, "我喜欢这个食物。");
    expect(user.content).toContain("【本句权威中文】我喜欢这个食物。");
    expect(user.content).toContain("原样");
    // 词表仍是「编号 词」逐行，不受影响
    expect(user.content).toContain("3 food.");
  });

  it("没给句级中文：不含该段（旧行为不变）", () => {
    const [, user] = buildMessages(words);
    expect(user.content).not.toContain("本句权威中文");
  });
});

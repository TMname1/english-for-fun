import { describe, expect, it } from "vitest";

import {
  buildCreateCoursePackPayload,
  parseCourseJsonImport,
  parseCourseOnlyJsonImport,
  parseCoursePackJsonImport,
  parseStatementsJson,
  validateStatements,
} from "../coursePackManage";

describe("parseStatementsJson", () => {
  it("parses valid statements and defaults phonetic to empty string", () => {
    const result = parseStatementsJson(
      JSON.stringify([{ english: "I am fine.", chinese: "我很好。" }]),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.statements).toEqual([
        { english: "I am fine.", chinese: "我很好。", phonetic: "" },
      ]);
    }
  });

  it("rejects empty text", () => {
    const result = parseStatementsJson("   ");
    expect(result).toEqual({ ok: false, error: "句子内容不能为空" });
  });

  it("rejects invalid json", () => {
    const result = parseStatementsJson("{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("不是合法的 JSON");
  });

  it("rejects empty array", () => {
    const result = parseStatementsJson("[]");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("至少要有 1 条");
  });

  it("rejects item without english", () => {
    const result = parseStatementsJson('[{ "chinese": "只有中文" }]');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("第 1 条句子缺少 english");
  });

  it("rejects non-string phonetic", () => {
    const result = parseStatementsJson('[{ "english": "hi", "chinese": "嗨", "phonetic": 123 }]');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("phonetic 必须是字符串");
  });
});

describe("validateStatements", () => {
  it("trims fields and defaults phonetic", () => {
    const result = validateStatements([
      { english: "  Hello.  ", chinese: "  你好。 ", phonetic: undefined as never },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.statements).toEqual([{ english: "Hello.", chinese: "你好。", phonetic: "" }]);
    }
  });

  it("rejects empty list", () => {
    expect(validateStatements([])).toEqual({ ok: false, error: "句子列表不能为空" });
  });

  it("rejects blank english", () => {
    const result = validateStatements([{ english: "   ", chinese: "嗨", phonetic: "" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("第 1 条句子缺少 english");
  });

  it("rejects blank chinese", () => {
    const result = validateStatements([
      { english: "hi", chinese: "  ", phonetic: "" },
      { english: "ok", chinese: "好", phonetic: "" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("第 1 条句子缺少 chinese");
  });
});

describe("buildCreateCoursePackPayload", () => {
  const pack = { title: "新课程包", description: "desc", cover: "" };
  const statements = [{ english: "Hello.", chinese: "你好。", phonetic: "/həˈloʊ/" }];

  it("builds a full payload with a single course object", () => {
    const result = buildCreateCoursePackPayload(pack, {
      title: "第一课",
      description: "",
      statements,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.title).toBe("新课程包");
      expect(result.payload.courses.title).toBe("第一课");
      expect(result.payload.courses.statements).toEqual(statements);
    }
  });

  it("requires pack title", () => {
    const result = buildCreateCoursePackPayload(
      { ...pack, title: "  " },
      {
        title: "第一课",
        description: "",
        statements,
      },
    );
    expect(result).toEqual({ ok: false, error: "课程包标题不能为空" });
  });

  it("course title is optional (omitted when blank)", () => {
    const result = buildCreateCoursePackPayload(pack, {
      title: "",
      description: "",
      statements,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.courses.title).toBeUndefined();
    }
  });

  it("surfaces empty-list errors", () => {
    const result = buildCreateCoursePackPayload(pack, {
      title: "第一课",
      description: "",
      statements: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("课程：");
      expect(result.error).toContain("句子列表不能为空");
    }
  });

  it("surfaces blank-field errors", () => {
    const result = buildCreateCoursePackPayload(pack, {
      title: "第一课",
      description: "",
      statements: [{ english: "  ", chinese: "嗨", phonetic: "" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("第 1 条句子缺少 english");
  });
});

describe("parseCourseJsonImport", () => {
  it("accepts the API format with phonetic", () => {
    const result = parseCourseJsonImport(
      JSON.stringify([{ english: "Hello.", chinese: "你好。", phonetic: "/həˈloʊ/" }]),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.statements).toEqual([
        { english: "Hello.", chinese: "你好。", phonetic: "/həˈloʊ/" },
      ]);
    }
  });

  it("normalizes xingrong soundmark to phonetic", () => {
    const result = parseCourseJsonImport(
      JSON.stringify([{ chinese: "我", english: "I", soundmark: "/aɪ/" }]),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.statements).toEqual([{ english: "I", chinese: "我", phonetic: "/aɪ/" }]);
    }
  });

  it("defaults missing phonetic to empty string", () => {
    const result = parseCourseJsonImport(JSON.stringify([{ english: "I", chinese: "我" }]));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.statements[0]!.phonetic).toBe("");
    }
  });

  it("rejects empty file text", () => {
    expect(parseCourseJsonImport("  ")).toEqual({ ok: false, error: "文件内容为空" });
  });

  it("rejects invalid json", () => {
    const result = parseCourseJsonImport("{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("不是合法的 JSON");
  });

  it("rejects non-array top level", () => {
    const result = parseCourseJsonImport('{"chapters": []}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("顶层必须是句子数组");
  });

  it("rejects empty array", () => {
    const result = parseCourseJsonImport("[]");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("至少要有 1 个句子");
  });

  it("rejects item without english", () => {
    const result = parseCourseJsonImport('[{ "chinese": "只有中文" }]');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("第 1 条句子缺少 english");
  });

  it("prefers phonetic over soundmark", () => {
    const result = parseCourseJsonImport(
      JSON.stringify([{ english: "I", chinese: "我", phonetic: "/aɪ/", soundmark: "/ignored/" }]),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.statements[0]!.phonetic).toBe("/aɪ/");
    }
  });
});

const fullPackJson = JSON.stringify({
  title: "neuro-1",
  description: "由本地 Course Forge 流水线生成（dialogue）",
  cover: "",
  courses: {
    title: "唯一课程",
    description: "开场",
    statements: [
      {
        english: "Hello.",
        chinese: "你好。",
        phonetic: "/həˈloʊ/",
        audioUrl: "/course-audio/a.mp3",
      },
      { english: "I", chinese: "我", soundmark: "/aɪ/" },
    ],
  },
});

describe("parseCoursePackJsonImport", () => {
  it("imports a full forge payload into pack + single course form", () => {
    const result = parseCoursePackJsonImport(fullPackJson);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pack).toEqual({
        title: "neuro-1",
        description: "由本地 Course Forge 流水线生成（dialogue）",
        cover: "",
      });
      expect(result.course.title).toBe("唯一课程");
      expect(result.course.description).toBe("开场");
      // soundmark 规范为 phonetic，audioUrl 等多余字段被丢弃
      expect(result.course.statements).toEqual([
        { english: "Hello.", chinese: "你好。", phonetic: "/həˈloʊ/" },
        { english: "I", chinese: "我", phonetic: "/aɪ/" },
      ]);
    }
  });

  it("imports are compatible with buildCreateCoursePackPayload", () => {
    const result = parseCoursePackJsonImport(fullPackJson);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const built = buildCreateCoursePackPayload(result.pack, result.course);
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.payload.courses.statements[1]).toEqual({
        english: "I",
        chinese: "我",
        phonetic: "/aɪ/",
      });
    }
  });

  it("rejects a top-level array", () => {
    const result = parseCoursePackJsonImport("[]");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("顶层必须是对象");
  });

  it("rejects missing title", () => {
    const result = parseCoursePackJsonImport(
      '{"courses": { "title": "a", "statements": [{ "english": "a", "chinese": "啊" }] } }',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("缺少 title");
  });

  it("rejects missing courses", () => {
    expect(parseCoursePackJsonImport('{"title": "pack"}').ok).toBe(false);
  });

  it("rejects legacy courses array (分课程格式)", () => {
    const result = parseCoursePackJsonImport(
      '{"title": "pack", "courses": [{ "title": "a", "statements": [{ "english": "hi", "chinese": "嗨" }] }]}',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("单一课程对象");
  });

  it("surfaces course errors", () => {
    const result = parseCoursePackJsonImport(
      '{"title": "pack", "courses": { "statements": [{ "english": "hi", "chinese": "嗨" }, { "chinese": "只有中文" }] }}',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("courses：第 2 条句子缺少 english");
  });
});

describe("parseCourseOnlyJsonImport", () => {
  it("imports a single course object", () => {
    const result = parseCourseOnlyJsonImport(
      '{ "title": "第一课", "statements": [{ "english": "hi", "chinese": "嗨" }] }',
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.course.title).toBe("第一课");
      expect(result.course.statements).toEqual([{ english: "hi", chinese: "嗨", phonetic: "" }]);
    }
  });

  it("accepts the { courses: {...} } single-object wrapper", () => {
    const result = parseCourseOnlyJsonImport(
      '{"courses": { "title": "第一课", "statements": [{ "english": "hi", "chinese": "嗨" }] }}',
    );
    expect(result.ok).toBe(true);
  });

  it("course title is optional", () => {
    const result = parseCourseOnlyJsonImport(
      '{ "statements": [{ "english": "hi", "chinese": "嗨" }] }',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.course.title).toBe("");
  });

  it("rejects legacy bare array (分课程格式)", () => {
    const result = parseCourseOnlyJsonImport(
      '[{ "title": "第一课", "statements": [{ "english": "hi", "chinese": "嗨" }] }]',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("单一课程对象");
  });

  it("rejects legacy courses array wrapper", () => {
    const result = parseCourseOnlyJsonImport(
      '{"courses": [{ "title": "第一课", "statements": [{ "english": "hi", "chinese": "嗨" }] }]}',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("旧的分课程格式");
  });

  it("rejects statements-less object", () => {
    const result = parseCourseOnlyJsonImport('{"title": "pack"}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("statements 必须是句子数组");
  });
});

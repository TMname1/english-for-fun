import { describe, expect, it } from "vitest";

import { buildCreateCoursePackPayload, parseStatementsJson } from "../coursePackManage";

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

describe("buildCreateCoursePackPayload", () => {
  const pack = { title: "新课程包", description: "desc", cover: "" };
  const statementsText = JSON.stringify([
    { english: "Hello.", chinese: "你好。", phonetic: "/həˈloʊ/" },
  ]);

  it("builds a full payload", () => {
    const result = buildCreateCoursePackPayload(pack, [
      { title: "第一课", description: "", statementsText },
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.title).toBe("新课程包");
      expect(result.payload.courses[0]!.statements).toEqual([
        { english: "Hello.", chinese: "你好。", phonetic: "/həˈloʊ/" },
      ]);
    }
  });

  it("requires pack title", () => {
    const result = buildCreateCoursePackPayload({ ...pack, title: "  " }, [
      { title: "第一课", description: "", statementsText },
    ]);
    expect(result).toEqual({ ok: false, error: "课程包标题不能为空" });
  });

  it("requires course title", () => {
    const result = buildCreateCoursePackPayload(pack, [
      { title: "", description: "", statementsText },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("第 1 门课程缺少标题");
  });

  it("surfaces statement errors with course index", () => {
    const result = buildCreateCoursePackPayload(pack, [
      { title: "第一课", description: "", statementsText },
      { title: "第二课", description: "", statementsText: "[]" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("第 2 门课程");
  });
});

import { parseCaptionResult, parseClockToMs, stripCaptionTags } from "../captioner";

/** 真实结构（见 scripts/probe-captioner.ts 的实测输出）：sentences 只有一条覆盖全文件 */
function captionResult(overrides: Record<string, unknown> = {}) {
  return {
    file_url: "oss://x/y.wav",
    properties: { original_duration_in_milliseconds: 57_005 },
    transcripts: [
      {
        channel_id: 0,
        content_duration_in_milliseconds: 57_005,
        text: JSON.stringify({
          speech_segments: [
            {
              start: "00:00.00",
              end: "00:01.60",
              language: [],
              text: "[音效=啵] [背景音乐渐起]",
            },
            {
              start: "00:01.60",
              end: "00:04.48",
              language: ["英文-通用美式"],
              text: "[说话人:女声]One more minute.",
            },
            {
              start: "00:04.48",
              end: "00:05.76",
              language: ["英文-通用美式"],
              text: "You unleash the beast?",
            },
          ],
        }),
        sentences: [{ begin_time: 0, end_time: 57_005, text: '{"sound_segments":[]}' }],
        ...overrides,
      },
    ],
  };
}

describe("parseClockToMs", () => {
  it("MM:SS.cc 的百分秒要右补零（00:06.08 是 6080ms）", () => {
    expect(parseClockToMs("00:06.08")).toBe(6_080);
    expect(parseClockToMs("00:00.00")).toBe(0);
    expect(parseClockToMs("01:02.50")).toBe(62_500);
  });

  it("支持 HH:MM:SS.cc", () => {
    expect(parseClockToMs("01:02:03.50")).toBe(3_723_500);
  });

  it("纯数字按毫秒处理", () => {
    expect(parseClockToMs(1_234)).toBe(1_234);
  });

  it("负值保留符号（跨段时 start 可能为负）", () => {
    expect(parseClockToMs("-00:01.60")).toBe(-1_600);
  });

  it("非法值返回 null 而不是抛错", () => {
    expect(parseClockToMs("n/a")).toBeNull();
    expect(parseClockToMs("12")).toBeNull();
    expect(parseClockToMs(undefined)).toBeNull();
  });
});

describe("stripCaptionTags", () => {
  it("去掉说话人/语气/音效标记", () => {
    expect(stripCaptionTags("[说话人:女声][语气:凶狠]Hello there.")).toBe("Hello there.");
    expect(stripCaptionTags("[音效=啵] [背景音乐渐起]")).toBe("");
  });
});

describe("parseCaptionResult", () => {
  it("优先使用 transcripts[].text 里的 speech_segments，并过滤无语音段", () => {
    const parsed = parseCaptionResult(captionResult());
    expect(parsed.source).toBe("speech_segments");
    expect(parsed.spans).toEqual([
      { beginMs: 1_600, endMs: 4_480 },
      { beginMs: 4_480, endMs: 5_760 },
    ]);
    expect(parsed.channelDurationMs).toBe(57_005);
  });

  it("负的 start 被 clamp 到 0", () => {
    const json = captionResult({
      text: JSON.stringify({
        speech_segments: [{ start: "-00:00.50", end: "00:02.00", text: "hi" }],
      }),
    });
    expect(parseCaptionResult(json).spans).toEqual([{ beginMs: 0, endMs: 2_000 }]);
  });

  it("没有 text（或 text 不是 JSON）时回退 sentences[]", () => {
    const json = captionResult({
      text: "not-json",
      sentences: [{ begin_time: 100, end_time: 3_000 }],
    });
    const parsed = parseCaptionResult(json);
    expect(parsed.source).toBe("sentences");
    expect(parsed.spans).toEqual([{ beginMs: 100, endMs: 3_000 }]);
  });

  it("段全被过滤且没有 sentences 时，用时长兜底成整段（纯音乐/静音）", () => {
    const json = captionResult({
      text: JSON.stringify({
        speech_segments: [{ start: "00:00.00", end: "00:03.00", text: "[音乐]" }],
      }),
      sentences: [],
      content_duration_in_milliseconds: 3_000,
    });
    const parsed = parseCaptionResult(json);
    expect(parsed.source).toBe("duration");
    expect(parsed.spans).toEqual([{ beginMs: 0, endMs: 3_000 }]);
  });

  it("丢弃 end<=begin 的段", () => {
    const json = captionResult({
      text: JSON.stringify({
        speech_segments: [
          { start: "00:02.00", end: "00:01.00", text: "bad" },
          { start: "00:03.00", end: "00:04.00", text: "ok" },
        ],
      }),
    });
    expect(parseCaptionResult(json).spans).toEqual([{ beginMs: 3_000, endMs: 4_000 }]);
  });

  it("多声道时优先取 channel_id=0", () => {
    const json = captionResult();
    (json.transcripts as unknown[]).unshift({
      channel_id: 1,
      content_duration_in_milliseconds: 1_000,
      text: JSON.stringify({
        speech_segments: [{ start: "00:00.00", end: "00:01.00", text: "ch1" }],
      }),
    });
    expect(parseCaptionResult({ ...json }, 0).spans).toEqual([
      { beginMs: 1_600, endMs: 4_480 },
      { beginMs: 4_480, endMs: 5_760 },
    ]);
  });

  it("什么都没有时抛错（任何失败整体报错）", () => {
    expect(() => parseCaptionResult({ transcripts: [{ channel_id: 0 }] })).toThrow(
      /未解析到任何语音时间段/,
    );
    expect(() => parseCaptionResult({})).toThrow(/没有 transcripts/);
  });
});

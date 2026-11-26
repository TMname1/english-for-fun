import { TextPromptClient } from "@langfuse/client";
import { propagateAttributes } from "@langfuse/tracing";

import {
  compilePrompt,
  findPromptVars,
  getManagedPrompt,
  PROMPT_EMPTY,
  resetPromptCacheForTest,
  setPromptGetterForTest,
  toCacheTtlSeconds,
  withPrompt,
} from "../prompt-store";

jest.mock("../tracing", () => ({ ensureTracingStarted: () => false }));
jest.mock("@langfuse/tracing", () => ({
  // 保留 SDK 其它导出：@langfuse/client 内部也 import 了 startActiveObservation
  ...jest.requireActual("@langfuse/tracing"),
  propagateAttributes: jest.fn((_attrs: unknown, fn: () => unknown) => fn()),
}));

const propagateMock = jest.mocked(propagateAttributes);

const NAME = "forge-unit-test-prompt";
const FALLBACK = "本地兜底 {{who}}";

/** 真实 TextPromptClient 夹具：构造不联网、无运行时校验 */
function textPrompt(
  overrides: { name?: string; version?: number; prompt?: string } = {},
): TextPromptClient {
  return new TextPromptClient({
    name: overrides.name ?? NAME,
    version: overrides.version ?? 7,
    labels: ["production"],
    tags: [],
    config: {},
    type: "text",
    prompt: overrides.prompt ?? "远端提示词",
  });
}

beforeEach(() => {
  resetPromptCacheForTest();
  setPromptGetterForTest(null);
  propagateMock.mockClear();
});

describe("compilePrompt（Mustache）", () => {
  it("替换已提供的变量；未提供的变量渲染为空串", () => {
    expect(compilePrompt("a {{x}} b {{y}}", { x: 1 })).toBe("a 1 b ");
  });

  it("无变量时原样返回（JSON 花括号不受影响）", () => {
    const text = '{"statements":[{"indexes":[0,1]}]}';
    expect(compilePrompt(text)).toBe(text);
    expect(compilePrompt(text, {})).toBe(text);
  });

  it("变量值不会被二次渲染（JSON 词表里的花括号安全）", () => {
    const out = compilePrompt("词表：{{words}}", { words: '[{"i":0,"word":"x"}] {{who}}' });
    expect(out).toBe('词表：[{"i":0,"word":"x"}] {{who}}');
  });

  it("不做 HTML 转义（SDK 已把 mustache.escape 置为恒等函数）", () => {
    const raw = "a & b < c > \"d\" 'e'";
    expect(compilePrompt("{{x}}", { x: raw })).toBe(raw);
  });
});

describe("findPromptVars", () => {
  it("列出模板里出现的变量名（去重）", () => {
    expect(findPromptVars("{{a}} {{b}} {{a}}")).toEqual(["a", "b"]);
  });

  it("只看模板，不会把转写文本里的花括号当成变量", () => {
    expect(findPromptVars("{{transcript}}")).toEqual(["transcript"]);
  });
});

describe("toCacheTtlSeconds", () => {
  it("毫秒向上取整到秒；0/负数/非法值表示禁用缓存", () => {
    expect(toCacheTtlSeconds(0)).toBe(0);
    expect(toCacheTtlSeconds(-1)).toBe(0);
    expect(toCacheTtlSeconds(Number.NaN)).toBe(0);
    expect(toCacheTtlSeconds(1)).toBe(1);
    expect(toCacheTtlSeconds(999)).toBe(1);
    expect(toCacheTtlSeconds(1000)).toBe(1);
    expect(toCacheTtlSeconds(60_000)).toBe(60);
    expect(toCacheTtlSeconds(60_001)).toBe(61);
  });
});

describe("getManagedPrompt", () => {
  it("未启用远端时直接返回兜底，且不调 getter", async () => {
    const getter = jest.fn();
    setPromptGetterForTest(getter);
    const p = await getManagedPrompt(NAME, FALLBACK, { vars: { who: "你" }, forceEnabled: false });
    expect(p).toMatchObject({
      template: FALLBACK,
      text: "本地兜底 你",
      name: NAME,
      version: null,
      isFallback: true,
      source: "fallback",
      label: "production",
    });
    expect(p).not.toHaveProperty("stale");
    expect(getter).not.toHaveBeenCalled();
  });

  it("远端成功：把 type/label/TTL/超时/重试都交给 SDK，返回远端文本与版本", async () => {
    const getter = jest.fn().mockResolvedValue(textPrompt({ version: 7 }));
    setPromptGetterForTest(getter);

    const p = await getManagedPrompt(NAME, FALLBACK, { forceEnabled: true });

    expect(getter).toHaveBeenCalledTimes(1);
    expect(getter).toHaveBeenCalledWith(NAME, {
      type: "text",
      label: "production",
      cacheTtlSeconds: 60,
      fetchTimeoutMs: 3000,
      maxRetries: 0,
    });
    expect(p).toMatchObject({
      template: "远端提示词",
      text: "远端提示词",
      name: NAME,
      version: 7,
      isFallback: false,
      source: "remote",
      label: "production",
    });
  });

  it("每次调用都按本次 vars 重新编译（缓存模板，不缓存结果）", async () => {
    setPromptGetterForTest(
      jest.fn().mockResolvedValue(textPrompt({ version: 2, prompt: "你好 {{who}}" })),
    );
    const a = await getManagedPrompt(NAME, FALLBACK, { vars: { who: "世界" }, forceEnabled: true });
    const b = await getManagedPrompt(NAME, FALLBACK, { vars: { who: "你" }, forceEnabled: true });
    expect(a.text).toBe("你好 世界");
    expect(b.text).toBe("你好 你");
    expect(a.template).toBe("你好 {{who}}");
  });

  it("远端失败回退兜底；同一个 name 只报一次 error（负缓存挡住后续请求）", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const getter = jest.fn().mockRejectedValue(new Error("boom"));
    setPromptGetterForTest(getter);

    const first = await getManagedPrompt(NAME, FALLBACK, { forceEnabled: true });
    const second = await getManagedPrompt(NAME, FALLBACK, { forceEnabled: true });

    expect(first.isFallback).toBe(true);
    expect(first.version).toBeNull();
    expect(first.text).toBe(FALLBACK);
    expect(second.isFallback).toBe(true);
    expect(getter).toHaveBeenCalledTimes(1); // 负缓存窗口内不再打远端
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it("版本不是正整数时视为拉取失败（否则 Langfuse 关联不到版本，观测计数恒为 0）", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    for (const version of [0, 1.5, "3"]) {
      resetPromptCacheForTest();
      setPromptGetterForTest(
        jest.fn().mockResolvedValue(textPrompt({ version: version as unknown as number })),
      );
      const p = await getManagedPrompt(NAME, FALLBACK, { forceEnabled: true });
      expect(p.isFallback).toBe(true);
      expect(p.version).toBeNull();
    }
    errorSpy.mockRestore();
  });

  it("远端是 chat 类型时回退（SDK 的 type 参数运行时不校验）", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const chatLike = {
      name: NAME,
      version: 3,
      prompt: [{ role: "system", content: "x" }],
    } as unknown as TextPromptClient;
    setPromptGetterForTest(jest.fn().mockResolvedValue(chatLike));

    const p = await getManagedPrompt(NAME, FALLBACK, { forceEnabled: true });
    expect(p.isFallback).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("当前只支持 Text"));
    errorSpy.mockRestore();
  });

  it("远端模板含 Mustache 控制语法时回退（避免后台误写改变渲染结构）", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    setPromptGetterForTest(
      jest.fn().mockResolvedValue(textPrompt({ prompt: "前缀 {{#x}}中间{{/x}} 后缀" })),
    );
    const p = await getManagedPrompt(NAME, FALLBACK, { forceEnabled: true });
    expect(p.isFallback).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Mustache 控制语法"));
    errorSpy.mockRestore();
  });

  it("未闭合的 {{ 让编译抛错，被兜底接住（fail-open）", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    setPromptGetterForTest(jest.fn().mockResolvedValue(textPrompt({ prompt: "x {{oops" })));
    const p = await getManagedPrompt(NAME, FALLBACK, { vars: { who: "你" }, forceEnabled: true });
    expect(p.isFallback).toBe(true);
    expect(p.text).toBe("本地兜底 你");
    errorSpy.mockRestore();
  });

  it("远端模板缺必需变量时回退（避免把没有输入的提示词发给模型）", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    setPromptGetterForTest(jest.fn().mockResolvedValue(textPrompt({ prompt: "旧版无变量提示词" })));
    const p = await getManagedPrompt(NAME, "兜底 {{words}} {{note}}", {
      vars: { words: "W", note: PROMPT_EMPTY },
      requiredVars: ["words", "note"],
      forceEnabled: true,
    });
    expect(p.isFallback).toBe(true);
    expect(p.text).toBe("兜底 W （无）");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("并发首拉单飞；失败后 30s 负缓存到期才允许重试", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const getter = jest.fn().mockRejectedValue(new Error("down"));
    setPromptGetterForTest(getter);

    const results = await Promise.all([
      getManagedPrompt(NAME, FALLBACK, { forceEnabled: true }),
      getManagedPrompt(NAME, FALLBACK, { forceEnabled: true }),
      getManagedPrompt(NAME, FALLBACK, { forceEnabled: true }),
    ]);
    expect(results.every((p) => p.isFallback)).toBe(true);
    expect(getter).toHaveBeenCalledTimes(1);

    // 负缓存窗口内仍不重试
    await getManagedPrompt(NAME, FALLBACK, { forceEnabled: true });
    expect(getter).toHaveBeenCalledTimes(1);

    // 31s 后窗口过期，允许再试一次
    let now = Date.now();
    const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
    now += 31_000;
    await getManagedPrompt(NAME, FALLBACK, { forceEnabled: true });
    expect(getter).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("withPrompt", () => {
  it("兜底提示词：不写 prompt 属性，但仍把 source 写进 metadata", async () => {
    const fn = jest.fn().mockResolvedValue("ok");
    await expect(
      withPrompt(
        {
          template: "x",
          text: "x",
          name: NAME,
          version: null,
          isFallback: true,
          source: "fallback",
          label: "production",
        },
        fn,
      ),
    ).resolves.toBe("ok");

    expect(fn).toHaveBeenCalledTimes(1);
    const attrs = propagateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(attrs).not.toHaveProperty("prompt");
    expect(attrs.metadata).toMatchObject({ prompt_name: NAME, prompt_source: "fallback" });
  });

  it("有版本时传 prompt name/version（Langfuse 据此统计 observations）", async () => {
    const fn = jest.fn().mockResolvedValue(42);
    await expect(
      withPrompt(
        {
          template: "x",
          text: "x",
          name: NAME,
          version: 2,
          isFallback: false,
          source: "remote",
          label: "production",
        },
        fn,
      ),
    ).resolves.toBe(42);

    const attrs = propagateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(attrs.prompt).toEqual({ name: NAME, version: 2, isFallback: false });
    expect(attrs.metadata).toMatchObject({ prompt_version: 2, prompt_source: "remote" });
  });
});

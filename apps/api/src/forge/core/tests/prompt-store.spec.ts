import {
  compilePrompt,
  getManagedPrompt,
  resetPromptCacheForTest,
  setPromptFetcherForTest,
  withPrompt,
} from "../prompt-store";

const NAME = "forge-unit-test-prompt";
const FALLBACK = "本地兜底 {{who}}";

describe("compilePrompt", () => {
  it("替换已提供的变量，保留未提供的占位符", () => {
    expect(compilePrompt("a {{x}} b {{y}}", { x: 1 })).toBe("a 1 b {{y}}");
  });

  it("无变量时原样返回（JSON 花括号不受影响）", () => {
    const text = '{"statements":[{"indexes":[0,1]}]}';
    expect(compilePrompt(text)).toBe(text);
  });
});

describe("getManagedPrompt", () => {
  beforeEach(() => {
    resetPromptCacheForTest();
  });

  it("未启用远端时直接返回兜底，且不调 fetcher", async () => {
    const fetcher = jest.fn();
    setPromptFetcherForTest(fetcher);
    const p = await getManagedPrompt(NAME, FALLBACK, { vars: { who: "你" }, forceEnabled: false });
    expect(p).toEqual({ text: "本地兜底 你", name: NAME, version: null, isFallback: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("远端成功时返回远端文本与版本，并按 TTL 命中缓存", async () => {
    const fetcher = jest.fn().mockResolvedValue({ text: "远端提示词", version: 7 });
    setPromptFetcherForTest(fetcher);
    const first = await getManagedPrompt(NAME, FALLBACK, { forceEnabled: true });
    const second = await getManagedPrompt(NAME, FALLBACK, { forceEnabled: true });
    expect(first).toEqual({ text: "远端提示词", name: NAME, version: 7, isFallback: false });
    expect(second).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("远端失败时回退兜底（无缓存）", async () => {
    setPromptFetcherForTest(jest.fn().mockRejectedValue(new Error("boom")));
    const p = await getManagedPrompt(NAME, FALLBACK, { forceEnabled: true });
    expect(p.isFallback).toBe(true);
    expect(p.version).toBeNull();
    expect(p.text).toBe(FALLBACK);
  });

  it("远端失败但已有缓存时继续用旧版本（stale-while-error）", async () => {
    setPromptFetcherForTest(jest.fn().mockResolvedValue({ text: "旧版本", version: 3 }));
    await getManagedPrompt(NAME, FALLBACK, { forceEnabled: true });

    // 让缓存过期，再让远端失败
    jest.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60 * 1000);
    setPromptFetcherForTest(jest.fn().mockRejectedValue(new Error("down")));
    const p = await getManagedPrompt(NAME, FALLBACK, { forceEnabled: true });
    expect(p).toEqual({ text: "旧版本", name: NAME, version: 3, isFallback: false });
    jest.restoreAllMocks();
  });
});

describe("withPrompt", () => {
  it("兜底提示词（无版本）不写追踪属性，直接执行", async () => {
    const fn = jest.fn().mockResolvedValue("ok");
    await expect(
      withPrompt({ text: "x", name: NAME, version: null, isFallback: true }, fn),
    ).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("有版本时仍返回原函数结果（追踪属性由 OTel 上下文传播）", async () => {
    const fn = jest.fn().mockResolvedValue(42);
    await expect(
      withPrompt({ text: "x", name: NAME, version: 2, isFallback: false }, fn),
    ).resolves.toBe(42);
  });
});

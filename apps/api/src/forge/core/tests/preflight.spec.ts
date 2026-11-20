import {
  estimateRequiredVramMb,
  evaluateVram,
  isLocalLlmBaseUrl,
  modelListed,
  normalizeModelId,
  parseModelListSizeMb,
  parseNvidiaSmiMemory,
  parseOllamaListModelMb,
} from "../preflight";

describe("parseNvidiaSmiMemory", () => {
  it("parses nounits csv lines", () => {
    expect(parseNvidiaSmiMemory("8188, 2048\n")).toEqual({ totalMb: 8188, usedMb: 2048 });
    expect(parseNvidiaSmiMemory(" 8188 ,7412 ")).toEqual({ totalMb: 8188, usedMb: 7412 });
  });

  it("returns null on empty or garbage output", () => {
    expect(parseNvidiaSmiMemory("")).toBeNull();
    expect(parseNvidiaSmiMemory("\n\n")).toBeNull();
    expect(parseNvidiaSmiMemory("ERROR: not found\n")).toBeNull();
  });
});

describe("modelListed", () => {
  it("matches exact ids and implicit :latest", () => {
    expect(modelListed(["qwen3:8b"], "qwen3:8b")).toBe(true);
    expect(modelListed(["qwen3"], "qwen3:latest")).toBe(true);
    expect(modelListed(["qwen3:latest"], "qwen3")).toBe(true);
  });

  it("rejects different tags and missing models", () => {
    expect(modelListed(["qwen3:4b", "llama3:latest"], "qwen3:8b")).toBe(false);
    expect(modelListed([], "qwen3:8b")).toBe(false);
  });
});

describe("normalizeModelId", () => {
  it("appends latest only when tag missing", () => {
    expect(normalizeModelId("qwen3")).toBe("qwen3:latest");
    expect(normalizeModelId("qwen3:8b")).toBe("qwen3:8b");
  });
});

describe("estimateRequiredVramMb", () => {
  it("weights MB rounded up plus margin", () => {
    expect(estimateRequiredVramMb(5324.2, 512)).toBe(5837);
    expect(estimateRequiredVramMb(100, 512)).toBe(612);
  });
});

describe("parseOllamaListModelMb", () => {
  const listOutput = [
    "NAME                    ID              SIZE      MODIFIED",
    "qwen3:8b                500a1f067a9f    5.2 GB    2 hours ago",
    "qwen2.5-coder:7b        dae161e27b0e    4.7 GB    9 hours ago",
    "qwen3-embedding:0.6b    ac6da0dfba84    639 MB    2 weeks ago",
  ].join("\n");

  it("parses GB and MB sizes for the requested model", () => {
    expect(parseOllamaListModelMb(listOutput, "qwen3:8b")).toBe(5325);
    expect(parseOllamaListModelMb(listOutput, "qwen3-embedding:0.6b")).toBe(639);
  });

  it("handles implicit :latest and returns null for unknown models", () => {
    expect(parseOllamaListModelMb("qwen3        abc        1 GB    now", "qwen3:latest")).toBe(
      1024,
    );
    expect(parseOllamaListModelMb(listOutput, "llama3:8b")).toBeNull();
    expect(parseOllamaListModelMb("NAME ID SIZE MODIFIED", "qwen3:8b")).toBeNull();
  });

  it("rejects unparseable size text", () => {
    expect(parseModelListSizeMb("5.2 XB")).toBeNull();
    expect(parseModelListSizeMb("n/a")).toBeNull();
    expect(parseModelListSizeMb("1.5 GiB")).toBe(1536);
  });
});

describe("evaluateVram", () => {
  // 5325MB 权重 + 512MB 余量 => 需要 5837MB
  const modelMb = 5325;
  const base = { marginMb: 512, strict: true };

  it("ok when free vram covers weights + margin", () => {
    const v = evaluateVram({ ...base, vram: { totalMb: 8188, usedMb: 2048 }, modelMb });
    expect(v.level).toBe("ok");
    if (v.level === "ok") {
      expect(v.freeMb).toBe(6140);
      expect(v.requiredMb).toBe(5837);
    }
  });

  it("fail in strict mode when free vram is not enough", () => {
    const v = evaluateVram({ ...base, vram: { totalMb: 8188, usedMb: 7412 }, modelMb });
    expect(v.level).toBe("fail");
    if (v.level === "fail") {
      expect(v.freeMb).toBe(776);
      expect(v.requiredMb).toBeGreaterThan(v.freeMb);
    }
  });

  it("warn instead of fail when strict is off", () => {
    const v = evaluateVram({
      ...base,
      strict: false,
      vram: { totalMb: 8188, usedMb: 7412 },
      modelMb,
    });
    expect(v.level).toBe("warn");
    if (v.level === "warn") {
      expect(v.message).toMatch(/CPU/);
    }
  });

  it("warns without blocking when data sources are missing", () => {
    expect(evaluateVram({ ...base, vram: null, modelMb }).level).toBe("warn");
    expect(evaluateVram({ ...base, vram: { totalMb: 8188, usedMb: 1 }, modelMb: null }).level).toBe(
      "warn",
    );
  });
});

describe("isLocalLlmBaseUrl", () => {
  it("识别本机端点", () => {
    expect(isLocalLlmBaseUrl("http://localhost:11434/v1")).toBe(true);
    expect(isLocalLlmBaseUrl("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isLocalLlmBaseUrl("http://myhost.localhost:1234/v1")).toBe(true);
  });

  it("云端端点与非法 URL 按云端处理（跳过本地预检而非误拦）", () => {
    expect(isLocalLlmBaseUrl("https://dashscope.aliyuncs.com/compatible-mode/v1")).toBe(false);
    expect(isLocalLlmBaseUrl("https://api.openai.com/v1")).toBe(false);
    expect(isLocalLlmBaseUrl("not-a-url")).toBe(false);
  });
});

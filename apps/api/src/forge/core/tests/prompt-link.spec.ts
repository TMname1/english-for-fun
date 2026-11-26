/**
 * 提示词与观测的关联：这是 Langfuse 「Number of Observations」的唯一数据来源。
 *
 * 目标：不连真 Langfuse，也能证明 `withPrompt` 之后创建的 span 上真的带上了
 * `langfuse.observation.prompt.name` / `.version` —— 之前 `withPrompt` 的单测只验返回值，
 * 属性是否真的发出去完全没测，所以「计数恒为 0」这类问题一直拦不住。
 *
 * 做法：NodeSDK（与生产同一套，负责装 AsyncLocalStorage context manager）+
 * LangfuseSpanProcessor（换成内存 exporter）+ 在 withPrompt 上下文里起一个 span。
 */
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { trace } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import type { ManagedPrompt } from "../prompt-store";
import { withPrompt } from "../prompt-store";

// withPrompt 里会确保追踪启动；测试自己装 NodeSDK，不能再让 tracing 去改全局 provider
jest.mock("../tracing", () => ({ ensureTracingStarted: () => false }));

const PROMPT_NAME_ATTR = "langfuse.observation.prompt.name";
const PROMPT_VERSION_ATTR = "langfuse.observation.prompt.version";

/** OTel 的全局 provider 只能注册一次，SDK 必须在文件级复用；每个用例前清空已导出 span */
const exporter = new InMemorySpanExporter();
const processor = new LangfuseSpanProcessor({
  exporter,
  publicKey: "pk-lf-test",
  secretKey: "sk-lf-test",
  // 不会真的发出去：exporter 已换成内存版
  baseUrl: "http://127.0.0.1:1",
  mediaUploadEnabled: false,
  // 这个 span 不是 Langfuse 观测，绕过默认过滤才能被导出
  shouldExportSpan: () => true,
});
const sdk = new NodeSDK({ spanProcessors: [processor] });

beforeAll(() => {
  sdk.start();
});

afterAll(async () => {
  await sdk.shutdown();
});

beforeEach(() => {
  exporter.reset();
});

function prompt(overrides: Partial<ManagedPrompt> = {}): ManagedPrompt {
  return {
    template: "x {{words}}",
    text: "x W",
    name: "forge-sentence-chain",
    version: 3,
    isFallback: false,
    source: "remote",
    label: "production",
    ...overrides,
  };
}

/** 在 withPrompt 的上下文里起一个 span，返回它落盘后的 attributes */
async function attributesAfter(
  managed: ManagedPrompt,
): Promise<{ attributes: Record<string, unknown>; text: string | undefined }> {
  let result: string | undefined;
  await withPrompt(managed, async () => {
    const span = trace.getTracer("prompt-link-test").startSpan("generation");
    span.end();
    result = "ok";
  });
  await processor.forceFlush();
  const spans = exporter.getFinishedSpans();
  expect(spans).toHaveLength(1);
  return { attributes: spans[0].attributes as Record<string, unknown>, text: result };
}

describe("withPrompt → Langfuse 观测关联", () => {
  it("远端提示词：span 上带 prompt name + 正整数 version（观测计数的前提）", async () => {
    const { attributes, text } = await attributesAfter(prompt());

    expect(text).toBe("ok");
    expect(attributes[PROMPT_NAME_ATTR]).toBe("forge-sentence-chain");
    expect(attributes[PROMPT_VERSION_ATTR]).toBe(3);
  });

  it("本地兜底：不写 prompt 属性（不伪装版本），但 metadata 里能看出走了 fallback", async () => {
    const { attributes } = await attributesAfter(
      prompt({ version: null, isFallback: true, source: "fallback" }),
    );

    expect(attributes[PROMPT_NAME_ATTR]).toBeUndefined();
    expect(attributes[PROMPT_VERSION_ATTR]).toBeUndefined();
    // metadata 由 propagateAttributes 序列化后挂在 langfuse.observation.metadata.* 上
    const serialized = JSON.stringify(attributes);
    expect(serialized).toContain("fallback");
  });
});

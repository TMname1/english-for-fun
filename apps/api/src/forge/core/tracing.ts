/**
 * Langfuse 追踪收口：把「LangChain/LangGraph 的回调钩子」接到 Langfuse。
 *
 * 机制（一句话）：`CallbackHandler` 实现 LangChain 的 callback 协议
 * （handleChainStart / handleChatModelStart / handleLLMEnd ...），把它放进
 * `config.callbacks`，框架在每次链路/节点/LLM 调用开始结束时自动回调它，
 * 它再把事件转成 OTel span 交给 `LangfuseSpanProcessor` 批量上报。
 *
 * 关键约束（改代码前务必看）：
 *   1. **只挂一处**：`CallbackManager.addHandler()` 只是 push、不去重
 *      （@langchain/core manager.js:439-442）。图路径挂在 graph.invoke 的 config 上，
 *      callbacks 会经 AsyncLocalStorage 向下继承到每个节点和节点里的 ChatOpenAI
 *      （runnables/base.js runWithConfig），所以不要再往 buildModel 上挂；
 *      legacy 路径没有图根，才在 buildModel 上挂（见 llm-client.ts）。
 *   2. **退出前必须 flush**：回调默认后台批量执行（LangChain >= 0.3），
 *      SDK 也是异步刷盘。子进程直接 process.exit() 会丢最后一批事件，
 *      所以 pipeline-runner / cli 的退出路径都要 await flushTracing()。
 *   3. **fail-open**：没配 key、SDK 起不来、初始化抛错，一律降级为「不追踪」，
 *      绝不因为可观测性把流水线搞挂。
 */
import { basename } from "node:path";

import { CallbackHandler } from "@langfuse/langchain";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";

import { config } from "./config";

export interface TraceAttrs {
  /** 会话 id：同一个 forge 任务（resume 前后）用同一个，Langfuse 里能串起来 */
  sessionId?: string;
  userId?: string;
  /** 标签，例如 ["forge:transcribe"] */
  tags?: string[];
  /** trace 元数据，落到 Langfuse 的 trace.metadata */
  metadata?: Record<string, unknown>;
}

/**
 * 当前是否处在 `graph.invoke` 内部。
 *
 * 用来让 llm-client 判断该不该在 ChatOpenAI 上兜底挂 handler：图内已经由图根的
 * callbacks 经 AsyncLocalStorage 继承下去了，再挂就重复；图外（legacy 编排，或图
 * 因 checkpoint 不可用而降级 legacy）没有根可继承，必须自己挂。
 */
let graphInvokeDepth = 0;

export function beginGraphInvoke(): void {
  graphInvokeDepth += 1;
}

export function endGraphInvoke(): void {
  graphInvokeDepth = Math.max(0, graphInvokeDepth - 1);
}

export function insideGraphInvoke(): boolean {
  return graphInvokeDepth > 0;
}

/**
 * 进程级开关：关掉 llm-client 在 ChatOpenAI 上挂兜底 handler 的行为。
 *
 * 只给 Studio 入口（`graph/dev-entry.ts`）用。那边的根 handler 是在 invoke config 里塞的
 * （见 `graph/studio-trace.ts`），没有走 `beginGraphInvoke` 这条计数路径；若模型层再兜底挂一份，
 * CallbackManager 不去重，同一次生成会上报两次 —— Langfuse 里表现为**每条 ChatOpenAI 各成
 * 一条 trace**（一次流水线几十条 root observation），而不是挂在 `forge-<phase>` 下面。
 *
 * 开关而不是计数：Studio 进程只跑图、永不跑 legacy，模型层兜底在那里没有存在的理由；
 * 而计数得跟着流式消费的整个生命周期走，异步生成器提前 break / 抛错都容易漏掉收尾。
 */
let fallbackTracingDisabled = false;

export function disableFallbackTracing(): void {
  fallbackTracingDisabled = true;
}

export function isFallbackTracingDisabled(): boolean {
  return fallbackTracingDisabled;
}

let sdk: NodeSDK | null = null;
let processor: LangfuseSpanProcessor | null = null;
let initAttempted = false;

/** 是否具备追踪条件（配了 key 且没被显式关掉）。纯读配置，不产生副作用 */
export function tracingEnabled(): boolean {
  return Boolean(config.langfuseEnabled && config.langfusePublicKey && config.langfuseSecretKey);
}

/**
 * 惰性初始化 OTel SDK + Langfuse span processor（幂等）。
 * 必须在创建 CallbackHandler 之前完成：handler 从 @opentelemetry/api 的全局
 * tracer 取 tracer，全局 provider 注册晚了 span 就没人接。
 * @returns 初始化成功返回 true
 */
function ensureStarted(): boolean {
  if (initAttempted) return sdk !== null;
  initAttempted = true;
  if (!tracingEnabled()) return false;

  try {
    processor = new LangfuseSpanProcessor({
      publicKey: config.langfusePublicKey,
      secretKey: config.langfuseSecretKey,
      baseUrl: config.langfuseBaseUrl,
      environment: config.langfuseEnvironment,
      // 批量上报：单批 20 条 / 2 秒，本地调试时能较快看到结果
      flushAt: 20,
      flushInterval: 2,
    });
    sdk = new NodeSDK({ spanProcessors: [processor] });
    sdk.start();
    return true;
  } catch (error) {
    console.warn(
      `[tracing] Langfuse 初始化失败，已跳过追踪: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    sdk = null;
    processor = null;
    return false;
  }
}

/**
 * legacy（命令式）编排的兜底 handler：挂在**模型构造器**上（ChatOpenAI / ASR ChatModel 共用）。
 *
 * legacy 路径没有 `graph.invoke` 这个根，callbacks 无从经 AsyncLocalStorage 继承，
 * 只能在模型构造器上挂。**图内必须返回空数组** —— 否则同一次调用会被 run.ts
 * 的图根 handler 与这里的 handler 各报一次（CallbackManager.addHandler 不去重）。
 *
 * 判断用 `insideGraphInvoke()` 而不是 `config.orchestrator`：图因 checkpoint 不可用而
 * 降级 legacy 时，orchestrator 仍是 graph，但实际跑的是 legacy，那种情况必须挂。
 * Studio 入口同理（根 handler 挂在 invoke config 上，见 studio-trace.ts），
 * 由 `isFallbackTracingDisabled()` 一次性关掉。
 *
 * 进程内只造一个实例：LLM 与 ASR 共用同一 sessionId/tags，legacy 下每条模型调用
 * 各成一条 trace（历史行为，未变）。
 */
let legacyHandlerReady = false;
let legacyHandler: CallbackHandler | null = null;

export function legacyModelCallbacks(): CallbackHandler[] {
  if (insideGraphInvoke() || isFallbackTracingDisabled()) return [];
  if (!legacyHandlerReady) {
    legacyHandlerReady = true;
    const outDir = process.env.FORGE_OUT_DIR;
    legacyHandler = newHandler({
      // pipeline-runner 会把产物目录放进 FORGE_OUT_DIR，用它当会话 id 把一轮任务串起来
      sessionId: outDir ? basename(outDir) : undefined,
      tags: ["forge:legacy"],
    });
  }
  return legacyHandler ? [legacyHandler] : [];
}

/**
 * 造一个挂在 LangChain config.callbacks 上的 handler。
 * 未启用追踪时返回 null，调用方用 `handler ? {callbacks:[handler]} : {}` 展开即可。
 */
export function newHandler(attrs: TraceAttrs = {}): CallbackHandler | null {
  if (!ensureStarted()) return null;
  return new CallbackHandler({
    sessionId: attrs.sessionId,
    userId: attrs.userId,
    tags: attrs.tags,
    traceMetadata: attrs.metadata,
  });
}

/**
 * 把积压的 span 全部推送出去并关停 SDK。进程退出前必须 await 它。
 * 重复调用安全；未启用追踪时立即 resolve。
 */
export async function flushTracing(): Promise<void> {
  const current = processor;
  const currentSdk = sdk;
  if (!current && !currentSdk) return;
  processor = null;
  sdk = null;
  try {
    if (current) await current.forceFlush();
  } catch (error) {
    console.warn(`[tracing] flush 失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    if (currentSdk) await currentSdk.shutdown();
  } catch {
    // 关停失败不影响进程退出，忽略
  }
}

/** 单测用：重置模块内状态，让下一个用例从干净状态开始 */
export function resetTracingForTest(): void {
  sdk = null;
  processor = null;
  initAttempted = false;
  graphInvokeDepth = 0;
  fallbackTracingDisabled = false;
  legacyHandlerReady = false;
  legacyHandler = null;
}

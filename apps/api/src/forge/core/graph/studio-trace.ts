/**
 * Studio（`pnpm dev:langsmith`）这条链路的「一次跑 = 一条 trace」。
 *
 * ## 为什么需要它
 *
 * 生产链路（`run.ts` 的 `buildRunConfig`）把根 handler 挂在 `graph.invoke` 的
 * `config.callbacks` 上，LangChain 再经 AsyncLocalStorage 继承给每个节点和节点里的
 * 每次 `ChatOpenAI` —— 所以 Langfuse / LangSmith 里一次跑只有一个 root，名字是
 * `forge-<phase>`。
 *
 * Studio 没有这个位置：`langgraphjs dev` 的 API server 自己调
 * `graph.streamEvents(input, { configurable, runId, tags, ... })`，config 由它拼，
 * **不含 callbacks**。于是 llm-client 的兜底逻辑（图外没有根可继承 → 在模型上挂）
 * 给每次 `ChatOpenAI` 各挂一份 handler，每次生成都成了独立的 trace ——
 * 一次流水线几十条 root observation，正是要修的毛病。
 *
 * ## 为什么不是 `graph.withConfig()`
 *
 * `withConfig` 把编译后的图包成 `RunnableBinding`，Studio 依赖的 getState /
 * updateState / interrupt 语义全丢，等于把 Studio 用坏。
 *
 * ## 做法：Proxy 透明包装
 *
 *   - **只拦执行入口**（invoke / ainvoke / stream / astream / streamEvents / astreamEvents），
 *     把 `runName` 与根 handler 合进 config；
 *   - **其余一律转发到真实例**：Proxy 的 target 就是编译好的 Pregel，`instanceof` 成立，
 *     langgraph-api 那句 `compiled.checkpointer = ...` / `compiled.store = ...` 也照常写回；
 *   - 转发方法时 **bind 到 target**：Pregel 里有 `#streamEventsV3` 这类私有方法，
 *     `this` 一旦是 Proxy 就会抛 TypeError（私有字段只认真实例）。
 *
 * 效果与生产一致：一次跑一条 trace，节点与每次 LLM 生成都挂在它下面；
 * 名字同样是 `forge-transcribe` / `forge-structure-resolve`。
 */
import type { RunnableConfig } from "@langchain/core/runnables";
import type { CallbackHandler } from "@langfuse/langchain";

import { isCommand } from "@langchain/langgraph";

import { newHandler } from "../tracing";

/** 吃 config 的执行入口；其余（getState / updateState / getGraph ...）都是状态 API，原样转发 */
const EXEC_METHODS = new Set([
  "invoke",
  "ainvoke",
  "stream",
  "astream",
  "streamEvents",
  "astreamEvents",
]);

/**
 * Studio 只有两种形态：fresh（`prepare` 起跑，等同于生产的 transcribe 阶段）与
 * resume（`Command({resume})` 从 reviewGate 续跑，等同于 structure-resolve）。
 *
 * 这里用 `isCommand` 的 `lg_name` 鸭子判定而不是 `instanceof Command`：
 * 命令是 langgraph-api 用自己的那份 `@langchain/langgraph` new 出来的，
 * 与图这边的副本不是同一个类，`instanceof` 会恒为 false。
 */
export function studioPhase(input: unknown): "transcribe" | "structure-resolve" {
  return isCommand(input) ? "structure-resolve" : "transcribe";
}

/** 合并 callbacks：server 可能已经塞了 tracer（配了 langsmith_project 时），别把它顶掉 */
function mergeCallbacks(
  existing: RunnableConfig["callbacks"],
  handler: CallbackHandler,
): RunnableConfig["callbacks"] {
  if (existing === undefined) return [handler];
  if (Array.isArray(existing)) return [...existing, handler];
  // CallbackManager.addHandler 只 push 不去重，copy 一份再加，避免污染入参里的 manager
  const copied = existing.copy();
  copied.addHandler(handler, true);
  return copied;
}

function tracedConfig(input: unknown, config: RunnableConfig | undefined): RunnableConfig {
  const phase = studioPhase(input);
  const threadId = config?.configurable?.thread_id;
  const handler = newHandler({
    // Studio 的 thread_id 等价于生产里的 jobId：同一个 thread 的多轮 resume 在 Langfuse 里串成一条会话
    sessionId: typeof threadId === "string" ? threadId : undefined,
    tags: [`forge:${phase}`],
    metadata: { phase, entry: "studio" },
  });
  return {
    ...config,
    // Langfuse 用 runName 当 trace 名，LangSmith 用它当根 run 名，与生产的 forge-<phase> 对齐
    runName: `forge-${phase}`,
    ...(handler ? { callbacks: mergeCallbacks(config?.callbacks, handler) } : {}),
  };
}

/**
 * 把「根 trace」挂到编译好的图上，返回一个行为等价的代理对象。
 * 未启用追踪（没配 key）时 handler 为 null，只注入 runName，其余照常。
 */
export function withRunRoot<T extends object>(graph: T): T {
  return new Proxy(graph, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (typeof prop !== "string" || !EXEC_METHODS.has(prop)) return value.bind(target);
      return (input: unknown, config?: RunnableConfig, ...rest: unknown[]) =>
        value.call(target, input, tracedConfig(input, config), ...rest);
    },
  });
}

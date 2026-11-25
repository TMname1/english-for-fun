/**
 * LangGraph Studio（`pnpm dev:langsmith`）的图入口，**仅供本地调试**，不参与生产链路：
 * 生产/CLI 仍走 `pipeline-runner.ts` → `run.ts`（FileCheckpointSaver + stdout JSON Lines）。
 *
 * 与 run.ts 的差异只有三点，都是为 Studio 服务的：
 *   1. checkpointer 用 MemorySaver —— Studio 自己按 thread 管会话，重启即清空，不写 outDir；
 *   2. 阶段事件打到 stdout（Studio 的日志面板），而不是序列化成 `{event:"stage"}` JSON Lines；
 *   3. 追踪根由 `withRunRoot` 注入 invoke config（Studio 的 API server 拼的 config 里没有
 *      callbacks），保证一次跑只有一条 trace，见 `studio-trace.ts`。
 *
 * 调试方式：在 Studio 的 Input 里给一条最小 state，例如
 *   {
 *     "jobId": "studio-dev",                 // 可选：省略则 state.jobId = ""
 *     "outDir": "D:/tmp/forge-studio",       // 可选：省略时落在 config.defaultOutRoot/<runId>
 *     "params": { "mediaPath": "D:/tmp/demo.mp4", "title": "Studio 调试", "type": "dialogue", "language": "en" }
 *   }
 * 注意只有 `params` 是必填对象，其中 `params.mediaPath` / `params.title` 是**必填**：
 * Studio 的 Input 面板用的是图的 **input schema**（`state.ts` 的 `ForgeInputSchema`，zod 定义，
 * 见 `build.ts` 里 `new StateGraph({ state, input })`），zod 里没 `.optional()` 的字段就显示为必填；
 * `graph.invoke` 同样按它校验，少传 `params` 会直接报 Required，不会拖到 `prepare` 才失败。
 * `jobId` / `outDir` 是 `.optional()`（都有回落值），只为省掉手填平台已知信息的那点麻烦。
 * 节点会**真实**跑 ffmpeg / ASR / LLM（读 apps/api/.env），所以请用小素材，别拿整集视频。
 * 只想看拓扑与中断行为：在 structureBatch 里把模型配成不可用，得到失败句后即可观察 reviewGate 的
 * interrupt，再用 Studio 的 "Resume" 提交 `{ "decisions": [{ "index": 0, "action": "delete" }] }`。
 */
import { MemorySaver } from "@langchain/langgraph";

import { disableFallbackTracing } from "../tracing";
import { buildForgeGraph } from "./build";
import { createStageEmitter } from "./events";
import { withRunRoot } from "./studio-trace";

/** Studio 日志面板里能直接看到阶段推进；不用 JSON Lines，避免和 Studio 自己的日志混成一片 */
const emitStage = createStageEmitter((stage) => {
  console.log(`[forge:stage] ${stage}`);
});

// 根 handler 已由 withRunRoot 挂到 invoke config；模型层再兜底挂一份，同一次生成会被上报两次
disableFallbackTracing();

export const graph = withRunRoot(
  buildForgeGraph({ emitStage }).compile({
    checkpointer: new MemorySaver(),
  }),
);

// 注：追踪靠 withRunRoot（见 studio-trace.ts）—— 它是编译后图的透明代理，把
// `runName: forge-<phase>` 和一个根 Langfuse handler 合并进 langgraph-api 传来的 config，
// 于是 Studio 里一次跑也只产生一条 trace，与 pipeline-runner 那条生产链路对齐。
// 不要换成 `graph.withConfig(...)`：那会把图包成 RunnableBinding，Studio 的
// getState / updateState / interrupt 全部失效。

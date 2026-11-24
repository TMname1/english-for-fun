/**
 * LangGraph Studio（`pnpm dev:langsmith`）的图入口，**仅供本地调试**，不参与生产链路：
 * 生产/CLI 仍走 `pipeline-runner.ts` → `run.ts`（FileCheckpointSaver + stdout JSON Lines）。
 *
 * 与 run.ts 的差异只有两点，都是为 Studio 服务的：
 *   1. checkpointer 用 MemorySaver —— Studio 自己按 thread 管会话，重启即清空，不写 outDir；
 *   2. 阶段事件打到 stdout（Studio 的日志面板），而不是序列化成 `{event:"stage"}` JSON Lines。
 *
 * 调试方式：在 Studio 的 Input 里给一条最小 state，例如
 *   {
 *     "jobId": "studio-dev",
 *     "outDir": "D:/tmp/forge-studio",      // 可省略，省略时落在 config.defaultOutRoot 下
 *     "params": { "mediaPath": "D:/tmp/demo.mp4", "title": "Studio 调试", "type": "dialogue", "language": "en" }
 *   }
 * 节点会**真实**跑 ffmpeg / ASR / LLM（读 apps/api/.env），所以请用小素材，别拿整集视频。
 * 只想看拓扑与中断行为：在 structureBatch 里把模型配成不可用，得到失败句后即可观察 reviewGate 的
 * interrupt，再用 Studio 的 "Resume" 提交 `{ "decisions": [{ "index": 0, "action": "delete" }] }`。
 */
import { MemorySaver } from "@langchain/langgraph";

import { buildForgeGraph } from "./build";
import { createStageEmitter } from "./events";

/** Studio 日志面板里能直接看到阶段推进；不用 JSON Lines，避免和 Studio 自己的日志混成一片 */
const emitStage = createStageEmitter((stage) => {
  console.log(`[forge:stage] ${stage}`);
});

export const graph = buildForgeGraph({ emitStage }).compile({
  checkpointer: new MemorySaver(),
});

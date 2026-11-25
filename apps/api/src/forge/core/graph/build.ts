/**
 * Forge 图的拓扑。
 *
 *   START → prepare → transcribe → structureBatch ──(无失败)──────────────► finalize → END
 *                                        └──(有失败)──► reviewGate(interrupt)
 *                                                          └─(resume)──► retryBatch
 *                                                                          ├─(仍有失败)─► reviewGate（再暂停，最多 3 轮）
 *                                                                          └─(已清空)──► finalize → END
 *
 * 「仍有失败」回到 reviewGate 而不是直接结束，是为了让 checkpoint 始终停在 pending interrupt 上：
 * 前端第 2、3 轮 resolve 仍能按 thread_id 续跑，不必降级 legacy。
 * resolve 不走「从某个节点重新开始」这种黑科技：新子进程用
 * `invoke(new Command({resume}), {configurable:{thread_id}})`，state 由 checkpoint 还原，
 * 框架自动从 reviewGate 的 pending interrupt 继续。
 */
import type { ExtractStateType, ExtractUpdateType } from "@langchain/langgraph";

import { END, START, StateGraph } from "@langchain/langgraph";

import type { ForgeArtifactSource } from "./artifacts";
import type { StageEmitter } from "./events";
import { ForgeArtifacts } from "./artifacts";
import { createNodes } from "./nodes";
import { ForgeInputSchema, ForgeState } from "./state";

/** 拓扑版本：节点/边/state 定义有结构变化时 +1，旧 checkpoint 会被判为不可用并降级 legacy */
export const GRAPH_VERSION = 1;

export interface ForgeGraphDeps {
  emitStage: StageEmitter;
  log?: (message: string) => void;
  /** 单测注入用：默认用真实磁盘/LLM 实现 */
  artifacts?: ForgeArtifactSource;
}

/** 图上的节点名（不含 START / END） */
type ForgeNodeName =
  | "prepare"
  | "transcribe"
  | "structureBatch"
  | "reviewGate"
  | "retryBatch"
  | "finalize";

/**
 * 显式写出返回类型，别让 TS 自己推导：
 * 推导结果里带 `AnnotationRoot<...>` 这类深层私有类型，declaration emit（tsc / IDE
 * 语言服务）无法为它生成可移植的引用，会报 TS2742「cannot be named without a
 * reference to AnnotationRoot from .../dist/web.cjs」。用仓内可命名的别名 + 包自己
 * 导出的 Extract* 辅助类型，等价但可移植。
 */
export type ForgeGraphDef = typeof ForgeState;
export type ForgeGraphState = ExtractStateType<ForgeGraphDef>;
export type ForgeGraphUpdate = ExtractUpdateType<ForgeGraphDef, ForgeGraphState>;
export type ForgeGraphBuilder = StateGraph<
  ForgeGraphDef,
  ForgeGraphState,
  ForgeGraphUpdate,
  ForgeNodeName | typeof START
>;

export function buildForgeGraph(deps: ForgeGraphDeps): ForgeGraphBuilder {
  const artifacts = deps.artifacts ?? new ForgeArtifacts(deps.emitStage);
  const nodes = createNodes(artifacts);

  // state 用 Annotation（要 default / 覆盖语义），另外挂一份 zod 的 `input`：
  // Studio 的 Input 面板与 invoke 入参校验都以它为准，这样 `params.mediaPath` / `title`
  // 才会显示成必填（Annotation 静态解析出来的 schema 里 required 恒为空，见 state.ts 顶部说明）。
  // 运行时是官方支持的 `{ state, input }` 形式，只是这版类型把 `_inputDefinition` 钉成
  // `AnnotationRoot`，所以这里显式转一次 —— 状态/更新的类型仍由 ForgeGraphBuilder 保证。
  const builder = new StateGraph({
    state: ForgeState,
    input: ForgeInputSchema,
  }) as unknown as ForgeGraphBuilder;

  return builder
    .addNode("prepare", nodes.prepare)
    .addNode("transcribe", nodes.transcribe)
    .addNode("structureBatch", nodes.structureBatch)
    .addNode("reviewGate", nodes.reviewGate)
    .addNode("retryBatch", nodes.retryBatch)
    .addNode("finalize", nodes.finalize)
    .addEdge(START, "prepare")
    .addEdge("prepare", "transcribe")
    .addEdge("transcribe", "structureBatch")
    .addConditionalEdges(
      "structureBatch",
      (state) => (state.failureCount > 0 ? "reviewGate" : "finalize"),
      ["reviewGate", "finalize"],
    )
    .addEdge("reviewGate", "retryBatch")
    .addConditionalEdges(
      "retryBatch",
      (state) => (state.failureCount > 0 ? "reviewGate" : "finalize"),
      ["reviewGate", "finalize"],
    )
    .addEdge("finalize", END);
}

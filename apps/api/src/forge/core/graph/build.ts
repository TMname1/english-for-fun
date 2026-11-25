/**
 * Forge 图的拓扑。
 *
 *   START → prepare → transcribe(子图) → structureBatch ──(无失败)──► finalize → END
 *                                        └──(有失败)──► reviewGate(interrupt)
 *                                                          └─(resume)──► retryBatch
 *                                                                          ├─(仍有失败)─► reviewGate（再暂停，最多 3 轮）
 *                                                                          └─(已清空)──► finalize → END
 *
 * `transcribe` 是一个**真子图节点**（见 transcribe-build.ts）：
 *   asrSentence(captioner 句级) → processingAudio(切块 ≤180s) → asrWord(asr-flash 词级)
 * 编译后直接 `.addNode("transcribe", compiled)` 挂载，因此 Studio / LangSmith 画布上会展开成
 * 三个嵌套节点。父子图 state 不同构，LangGraph 按 channel 名对齐（子图只读到 outDir/params，
 * 回写时父图按 channel 白名单过滤）；子图 checkpoint 落在 `transcribe:<taskId>` 的
 * checkpoint_ns 下，`FileCheckpointSaver` 按 (threadId, ns) 隔离，仍是同一个文件。
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
import type { TranscribeArtifactSource } from "./transcribe-artifacts";
import { ForgeArtifacts } from "./artifacts";
import { createNodes } from "./nodes";
import { ForgeInputSchema, ForgeState } from "./state";
import { buildTranscribeGraph } from "./transcribe-build";

/** 拓扑版本：节点/边/state 定义有结构变化时 +1，旧 checkpoint 会被判为不可用并降级 legacy */
// v2：transcribe 改为子图（asrSentence → processingAudio → asrWord），产物新增 caption/chunk-plan
// v3：transcribe 改为直接挂载编译后子图（真嵌套，checkpoint_ns 分命名空间），并删除只写不读的 transcriptStat
export const GRAPH_VERSION = 3;

export interface ForgeGraphDeps {
  emitStage: StageEmitter;
  log?: (message: string) => void;
  /** 单测注入用：默认用真实磁盘/LLM 实现 */
  artifacts?: ForgeArtifactSource;
  /** 单测注入用：transcribe 子图的磁盘/网络实现；默认 TranscribeArtifacts 会真跑 ffmpeg / ASR / LLM */
  transcribeArtifacts?: TranscribeArtifactSource;
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

/**
 * 父图节点面 = `addNode` 第二个参数的类型。编译后的子图入参/出参是 `TranscriptStateType`，
 * 与父图不同构，必须显式转一次才能交给 `addNode`（运行时按 channel 名对齐，见文件头注释）。
 * 用 `Parameters<...>` 取而不是手写 `RunnableLike`：`NodeAction` 还接受普通函数与 map 形态，
 * 手写会漏掉重载；这里也不引入包内私有类型，避免 TS2742。
 */
type ForgeNodeAction = Parameters<ForgeGraphBuilder["addNode"]>[1];

export function buildForgeGraph(deps: ForgeGraphDeps): ForgeGraphBuilder {
  const artifacts = deps.artifacts ?? new ForgeArtifacts(deps.emitStage);
  const nodes = createNodes(artifacts);

  // transcribe 子图（asrSentence → processingAudio → asrWord）：构图期编译，只组装节点不碰磁盘。
  // **不传 checkpointer**：运行期由父图经 config 的 CONFIG_KEY_CHECKPOINTER 把同一个 saver 借给它。
  const transcribe = buildTranscribeGraph({
    emitStage: deps.emitStage,
    artifacts: deps.transcribeArtifacts,
    log: deps.log,
  }).compile({ name: "forge-transcribe-subgraph" });

  // state 用 Annotation（要 default / 覆盖语义），另外挂一份 zod 的 `input`：
  // Studio 的 Input 面板与 invoke 入参校验都以它为准，这样 `params.mediaPath` / `title`
  // 才会显示成必填（Annotation 静态解析出来的 schema 里 required 恒为空，见 state.ts 顶部说明）。
  // 运行时是官方支持的 `{ state, input }` 形式，只是这版类型把 `_inputDefinition` 钉成
  // `AnnotationRoot`，所以这里显式转一次 —— 状态/更新的类型仍由 ForgeGraphBuilder 保证。
  const builder = new StateGraph({
    state: ForgeState,
    input: ForgeInputSchema,
  }) as unknown as ForgeGraphBuilder;

  return (
    builder
      .addNode("prepare", nodes.prepare)
      // 编译子图直接挂上去：LangGraph 认 isPregelLike → 登记为 subgraph，Studio 画布展开成三个子节点。
      // 不要传 `{ input: TranscriptState }`：那会把 params 裁成 TranscriptParams，回写时丢 title/type。
      .addNode("transcribe", transcribe as unknown as ForgeNodeAction)
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
      .addEdge("finalize", END)
  );
}

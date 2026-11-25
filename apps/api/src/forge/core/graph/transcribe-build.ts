/**
 * transcribe 子图的拓扑与编译产物。
 *
 *   START → asrSentence → processingAudio → asrWord → END
 *
 * 这是一个**真实的编译后子图**：`buildForgeGraph` 直接
 * `.addNode("transcribe", compiled)` 把它挂到父图，LangGraph 按嵌套子图执行
 * （节点在 Studio / LangSmith 画布上展开成三个子节点，运行时子图 checkpoint
 * 写在 `transcribe:<taskId>` 的 `checkpoint_ns` 下；`FileCheckpointSaver` 按
 * `(threadId, ns)` 隔离，仍然落在同一个 `graph.checkpoint.json` 里）。
 *
 * 编译时**不传 checkpointer**：运行期由父图经 config 的 `CONFIG_KEY_CHECKPOINTER`
 * 借出同一个 saver（Studio 的 `MemorySaver` 同理）。
 *
 * 父图与子图 state 不同构（父图多 title/type/description，子图多几个计数），
 * LangGraph 按 **channel 名**对齐：子图只读到 `outDir` / `params`，回写时父图按
 * 自己的 channel 白名单过滤，子图的计数不会污染父图。因此**不要**给 `addNode`
 * 传 `{ input: TranscriptState }`：那会把 `params` 裁成 `TranscriptParams`，
 * 回写时丢掉 title/type/description。
 */
import { END, START, StateGraph } from "@langchain/langgraph";

import type { StageEmitter } from "./events";
import type { TranscribeArtifactSource, TranscribeIO } from "./transcribe-artifacts";
import type {
  TranscriptGraphBuilder,
  TranscriptStateType,
  TranscriptStateUpdate,
} from "./transcribe-state";
import { TranscribeArtifacts } from "./transcribe-artifacts";
import { TranscriptState } from "./transcribe-state";

export interface TranscribeGraphDeps {
  emitStage: StageEmitter;
  log?: (message: string) => void;
  /** 单测注入：假的磁盘/网络实现 */
  artifacts?: TranscribeArtifactSource;
  /** 单测注入：只替换某个 IO（caption / asr / ffmpeg / preprocess） */
  io?: Partial<TranscribeIO>;
}

/** 节点只做「调用 artifacts + 返回 state 更新」，与主图 nodes.ts 同样的分工 */
function createTranscribeNodes(artifacts: TranscribeArtifactSource) {
  return {
    asrSentence: (state: TranscriptStateType): Promise<TranscriptStateUpdate> =>
      artifacts.asrSentence(state),
    processingAudio: (state: TranscriptStateType): Promise<TranscriptStateUpdate> =>
      artifacts.processingAudio(state),
    asrWord: (state: TranscriptStateType): Promise<TranscriptStateUpdate> =>
      artifacts.asrWord(state),
  };
}

/** 显式返回类型：StateGraph 的泛型里带包内私有类型，交给 TS 推导会触发 TS2742 */
export function buildTranscribeGraph(deps: TranscribeGraphDeps): TranscriptGraphBuilder {
  const artifacts = deps.artifacts ?? new TranscribeArtifacts(deps.emitStage, deps.io, deps.log);
  const nodes = createTranscribeNodes(artifacts);

  const builder = new StateGraph(TranscriptState) as unknown as TranscriptGraphBuilder;
  return builder
    .addNode("asrSentence", nodes.asrSentence)
    .addNode("processingAudio", nodes.processingAudio)
    .addNode("asrWord", nodes.asrWord)
    .addEdge(START, "asrSentence")
    .addEdge("asrSentence", "processingAudio")
    .addEdge("processingAudio", "asrWord")
    .addEdge("asrWord", END);
}

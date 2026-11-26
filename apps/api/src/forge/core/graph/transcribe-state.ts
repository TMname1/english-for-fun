/**
 * transcribe 子图的状态。
 *
 * 与主图 `ForgeState` 同样遵循「大对象不进 state」：caption 段表、chunk 列表、
 * 逐块词表、transcript 本体全部落磁盘（`caption.json` / `chunk-plan.json` /
 * `transcript.json`），这里只放控制流与几个计数，节点间传递成本恒定。
 *
 * 类型写法与 `graph/state.ts` / `graph/build.ts` 一致：显式写出 channel 表与
 * builder 类型，避免 TS2742（declaration emit 无法命名 `AnnotationRoot` /
 * `BaseChannel` 这类包内私有类型）。
 */
import type {
  AnnotationRoot,
  BaseChannel,
  ExtractStateType,
  ExtractUpdateType,
  OverwriteValue,
} from "@langchain/langgraph";

import { Annotation, START, StateGraph } from "@langchain/langgraph";

import type { ClipRange } from "../types";
import type { ForgeLanguage } from "./state";

/** 子图入参：父图按 channel 名对齐时只会传这两个（title/type/description 子图用不到，原样带过） */
export interface TranscriptParams {
  mediaPath: string;
  /** 已规整的切片区间（绝对秒）；缺省转写整段 */
  clips?: ClipRange[];
  language: ForgeLanguage;
}

type ValueChannel<T> = BaseChannel<T, T | OverwriteValue<T>, unknown>;

type TranscriptChannels = {
  outDir: ValueChannel<string>;
  params: ValueChannel<TranscriptParams>;
  /** captioner 处理的 unit 数（= clips 数，无切片时为 1） */
  unitCount: ValueChannel<number>;
  /** 切出的音频块数 */
  chunkCount: ValueChannel<number>;
  /** 已转写完成的块数（asrWord 结束时等于 chunkCount） */
  chunkDone: ValueChannel<number>;
  /** 预处理后的句数 */
  segmentCount: ValueChannel<number>;
  /** 是否有词级时间戳 */
  wordLevel: ValueChannel<boolean>;
  /** 因块边界中点规则被丢弃的词数（重复/越界），用于观测切块质量 */
  droppedWords: ValueChannel<number>;
};

export const TranscriptState: AnnotationRoot<TranscriptChannels> = Annotation.Root({
  outDir: Annotation<string>({ reducer: (_prev, next) => next, default: () => "" }),
  params: Annotation<TranscriptParams>({
    reducer: (_prev, next) => next,
    default: () => ({ mediaPath: "", language: "en" }),
  }),
  unitCount: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
  chunkCount: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
  chunkDone: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
  segmentCount: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
  wordLevel: Annotation<boolean>({ reducer: (_prev, next) => next, default: () => false }),
  droppedWords: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
});

export type TranscriptStateType = typeof TranscriptState.State;
export type TranscriptStateUpdate = Partial<TranscriptStateType>;

/** 子图拓扑（暴露给 build.ts 的显式类型，见文件头说明） */
export type TranscriptGraphDef = typeof TranscriptState;
export type TranscriptGraphState = ExtractStateType<TranscriptGraphDef>;
export type TranscriptGraphUpdate = ExtractUpdateType<TranscriptGraphDef, TranscriptGraphState>;
export type TranscriptNodeName = "asrSentence" | "processingAudio" | "asrWord";
export type TranscriptGraphBuilder = StateGraph<
  TranscriptGraphDef,
  TranscriptGraphState,
  TranscriptGraphUpdate,
  TranscriptNodeName | typeof START
>;

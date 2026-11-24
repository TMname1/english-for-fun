/**
 * Forge 图的状态定义。
 *
 * 取舍：**大对象不进 state**。transcript（可能几百段 × 每段几十个词）与失败明细
 * （含模型原始输出）都留在磁盘上，节点内按需 readJson；state 里只放控制流与摘要，
 * 避免 checkpoint 被复制多份后随产物上传膨胀。
 */
import type { AnnotationRoot, BaseChannel, OverwriteValue } from "@langchain/langgraph";

import { Annotation } from "@langchain/langgraph";

import type { ClipRange, DraftChain, ForgeStage, ResolveDecision } from "../types";

export interface ForgeParams {
  /** fresh 阶段必填：源媒体绝对路径 */
  mediaPath?: string;
  title?: string;
  description?: string;
  type: "dialogue" | "music";
  language: string;
  /** 已规整（排序 / 越界裁剪）后的切片区间；缺省转写整段 */
  clips?: ClipRange[];
}

export interface TranscriptStat {
  segments: number;
  wordLevel: boolean;
  clipCount: number;
}

/**
 * `Annotation<T>({ reducer })` 实际返回的 channel 形态。
 *
 * 显式写出 channel 表而不是依赖 `Annotation.Root` 的推断：推断类型会指向
 * `@langchain/langgraph` 内部的 `BaseChannel`（该包有 index / web 两个类型入口，
 * 不同 tsconfig 会解析到不同文件），开启 `declaration` 后 TS 无法稳定命名它，
 * 报 TS2742「cannot be named without a reference to ... BaseChannel」。显式注解可消除。
 */
type ValueChannel<T> = BaseChannel<T, T | OverwriteValue<T>, unknown>;

type ForgeChannels = {
  jobId: ValueChannel<string>;
  outDir: ValueChannel<string>;
  params: ValueChannel<ForgeParams>;
  stage: ValueChannel<ForgeStage>;
  transcriptStat: ValueChannel<TranscriptStat | null>;
  chains: ValueChannel<DraftChain[]>;
  failureCount: ValueChannel<number>;
  failureIndexes: ValueChannel<number[]>;
  round: ValueChannel<number>;
  decisions: ValueChannel<ResolveDecision[] | null>;
  statementCount: ValueChannel<number>;
  alignRate: ValueChannel<number>;
  needsFix: ValueChannel<boolean>;
};

export const ForgeState: AnnotationRoot<ForgeChannels> = Annotation.Root({
  /** 与 thread_id 相同，仅用于日志与交叉校验 */
  jobId: Annotation<string>({ reducer: (_prev, next) => next, default: () => "" }),
  /** 产物目录（绝对路径）：节点所有磁盘 IO 的根 */
  outDir: Annotation<string>({ reducer: (_prev, next) => next, default: () => "" }),
  params: Annotation<ForgeParams>({
    reducer: (_prev, next) => next,
    default: () => ({ type: "dialogue", language: "en" }),
  }),
  stage: Annotation<ForgeStage>({ reducer: (_prev, next) => next, default: () => "transcoding" }),
  /** 转写摘要；正文在 transcript.json */
  transcriptStat: Annotation<TranscriptStat | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  /**
   * 结构化产物。**用覆盖而不是按 index 合并**：resolve 轮次需要能「删掉」某些句，
   * 合并式 reducer 无法表达删除（被删的 index 会从上一版里留下来）。
   */
  chains: Annotation<DraftChain[]>({ reducer: (_prev, next) => next, default: () => [] }),
  failureCount: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
  failureIndexes: Annotation<number[]>({ reducer: (_prev, next) => next, default: () => [] }),
  /** 已进入 reviewGate 的轮次：防止用户反复重试导致无限循环 */
  round: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
  /** 前端对失败句的决策（来自 Command({resume})） */
  decisions: Annotation<ResolveDecision[] | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  statementCount: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
  alignRate: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
  needsFix: Annotation<boolean>({ reducer: (_prev, next) => next, default: () => false }),
});

export type ForgeStateType = typeof ForgeState.State;
export type ForgeStateUpdate = Partial<ForgeStateType>;

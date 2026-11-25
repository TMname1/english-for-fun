/**
 * 图节点：只做「调用 artifacts + 决定返回哪个 state 更新」。
 *
 * `reviewGate` 必须是**纯节点**（只读进度快照 + interrupt，不调 LLM、不写文件）：
 * LangGraph 在 resume 时会从调用 interrupt 的那个节点开头重放，有副作用就会重复计费/重复写盘。
 */
import { interrupt } from "@langchain/langgraph";

import type { ResolveDecision } from "../types";
import type { ForgeArtifactSource } from "./artifacts";
import type { ForgeStateType, ForgeStateUpdate } from "./state";
import { validateResolveDecisions } from "../forge";
import { MAX_REVIEW_ROUNDS } from "./artifacts";

/** interrupt 时抛给调用方的载荷（runner 只把它当日志信息，前端仍读 structure.progress.json） */
export interface ReviewInterruptPayload {
  failureCount: number;
  failureIndexes: number[];
  outDir: string;
  round: number;
}

/** Command({resume}) 的值：前端对每个失败句的选择 */
export interface ReviewResumePayload {
  decisions?: ResolveDecision[];
}

export function createNodes(artifacts: ForgeArtifactSource) {
  return {
    prepare: (state: ForgeStateType): Promise<ForgeStateUpdate> => artifacts.prepare(state),
    structureBatch: (state: ForgeStateType): Promise<ForgeStateUpdate> =>
      artifacts.structureBatch(state),
    retryBatch: (state: ForgeStateType): Promise<ForgeStateUpdate> => artifacts.retryBatch(state),
    finalize: (state: ForgeStateType): Promise<ForgeStateUpdate> => artifacts.finalize(state),

    /** 结构化有失败句：暂停等人工决策；resume 后校验并放行到 retryBatch */
    reviewGate: async (state: ForgeStateType): Promise<ForgeStateUpdate> => {
      const progress = await artifacts.readProgress(state.outDir);
      const failures = progress?.failures ?? [];
      // checkpoint 里 round 已累计的轮次过多 → 直接失败，避免无限重试
      if (state.round >= MAX_REVIEW_ROUNDS) {
        throw new Error(
          `[forge] 已连续 ${state.round} 轮仍有 ${failures.length} 句未通过校验，请检查模型输出或更换更强的模型`,
        );
      }

      const payload: ReviewInterruptPayload = {
        failureCount: failures.length,
        failureIndexes: failures.map((f) => f.index).sort((a, b) => a - b),
        outDir: state.outDir,
        round: state.round,
      };
      const resumed = interrupt<ReviewInterruptPayload, ReviewResumePayload | undefined>(payload);
      const decisions = resumed?.decisions ?? [];
      if (!progress) {
        throw new Error("[forge] 缺少结构化进度快照，无法按决策续跑");
      }
      validateResolveDecisions(decisions, progress);

      return { decisions, round: state.round + 1 };
    },
  };
}

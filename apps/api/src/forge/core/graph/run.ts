/**
 * 图编排的阶段入口（被 pipeline-runner 调用，仍在子进程内运行）。
 *
 * 职责边界：
 *   - 只负责「挑阶段 → 组 config/Command → 判终态」；
 *   - 不写 stdout（事件由调用方的 emit 回调负责），不读环境变量（参数由调用方给）。
 */
import { Command, isInterrupted } from "@langchain/langgraph";

import type { ForgeStage } from "../forge";
import type { ResolveDecision } from "../types";
import type { ForgeParams } from "./state";
import { config } from "../config";
import { paths, readJson } from "../forge";
import { buildForgeGraph, GRAPH_VERSION } from "./build";
import { createStageEmitter } from "./events";
import { cleanupCheckpointTmp, FileCheckpointSaver } from "./file-checkpointer";

export type GraphPhase = "transcribe" | "structure" | "structure-resolve";

export interface GraphRunInput {
  phase: GraphPhase;
  /** 与 thread_id 一致；恢复时用于校验 checkpoint 归属 */
  jobId: string;
  outDir: string;
  /** fresh（transcribe）阶段必填；resolve 阶段忽略（state 由 checkpoint 还原） */
  params: ForgeParams;
}

/** unavailable 表示 checkpoint 不可用（旧任务 / 拓扑升级 / 未停在暂停点），调用方应降级 legacy */
export type GraphRunOutcome = "done" | "needs_fix" | "unavailable";

export async function runForgeGraph(
  input: GraphRunInput,
  onStage: (stage: ForgeStage) => void,
): Promise<GraphRunOutcome> {
  const checkpointFile = paths.checkpoint(input.outDir);
  await cleanupCheckpointTmp(checkpointFile);

  const saver = new FileCheckpointSaver(checkpointFile, {
    keep: config.checkpointKeep,
    graphVersion: GRAPH_VERSION,
  });
  const emitStage = createStageEmitter(onStage);
  const graph = buildForgeGraph({ emitStage }).compile({ checkpointer: saver });
  const runConfig = { configurable: { thread_id: input.jobId } };

  if (input.phase === "structure-resolve") {
    if (!(await canResume(input.jobId, graph, saver))) {
      console.warn(
        "[forge] checkpoint 不可用（缺失 / 线程不符 / 拓扑版本不符 / 未停在暂停点），降级 legacy 续跑",
      );
      return "unavailable";
    }
    const resolveRaw = await readJson<{ decisions?: ResolveDecision[] }>(
      paths.resolve(input.outDir),
    ).catch(() => ({ decisions: [] as ResolveDecision[] }));
    const result = await graph.invoke(
      new Command({ resume: { decisions: resolveRaw?.decisions ?? [] } }),
      runConfig,
    );
    return isInterrupted(result) ? "needs_fix" : "done";
  }

  const result = await graph.invoke(
    { jobId: input.jobId, outDir: input.outDir, params: input.params },
    runConfig,
  );
  return isInterrupted(result) ? "needs_fix" : "done";
}

/**
 * 能否按 checkpoint 续跑：文件在 + 线程一致 + 拓扑版本一致 + 当前确实停在 reviewGate。
 * 任一不满足就降级 legacy —— 旧任务本来没有 checkpoint 文件，天然走到这里。
 */
async function canResume(
  jobId: string,
  graph: { getState: (config: RunConfig) => Promise<{ next?: string[] }> },
  saver: FileCheckpointSaver,
): Promise<boolean> {
  const head = await saver.inspect();
  if (!head.exists) return false;
  if (head.threadId !== jobId) return false;
  if (head.graphVersion !== GRAPH_VERSION) return false;

  const state = await graph.getState({ configurable: { thread_id: jobId } });
  return (state.next ?? []).includes("reviewGate");
}

interface RunConfig {
  configurable: { thread_id: string };
}

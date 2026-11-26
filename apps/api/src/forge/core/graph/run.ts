/**
 * 图编排的阶段入口（被 pipeline-runner 调用，仍在子进程内运行）。
 *
 * 职责边界：
 *   - 只负责「挑阶段 → 组 config/Command → 判终态」；
 *   - 不写 stdout（事件由调用方的 emit 回调负责），不读环境变量（参数由调用方给）。
 */
import type { RunnableConfig } from "@langchain/core/runnables";

import { Command, isInterrupted } from "@langchain/langgraph";

import type { ForgeStage } from "../forge";
import type { ResolveDecision } from "../types";
import type { ForgeParams } from "./state";
import { config } from "../config";
import { paths, readJson } from "../forge";
import { beginGraphInvoke, endGraphInvoke, newHandler } from "../tracing";
import { buildForgeGraph, GRAPH_VERSION } from "./build";
import { createStageEmitter } from "./events";
import { cleanupCheckpointTmp, FileCheckpointSaver } from "./file-checkpointer";

export type GraphPhase = "transcribe" | "structure" | "structure-resolve";

/** fresh 与续跑共用的定位信息 */
export interface GraphRunBase {
  /** 与 thread_id 一致；恢复时用于校验 checkpoint 归属 */
  jobId: string;
  outDir: string;
}

/**
 * 阶段入口入参。用可辨识联合把「必填」写进类型，而不是靠注释/运行时兜底：
 *
 * - `transcribe`（fresh）：`prepare` 要用 mediaPath/title 写 meta.json，缺了必然启动即失败，
 *   所以 `params: ForgeParams`（mediaPath/title 为 string，非 optional）；
 * - `structure-resolve`（续跑）：state 由 checkpoint 还原，`params` 仅作兜底，可省略。
 *
 * 注意：这里**不读环境变量**。直接调图（Studio / 脚本 / 单测）时没人替你注入
 * `FORGE_MEDIA_PATH`，必须自己把 `params.mediaPath` 传全。
 */
export type GraphRunInput =
  | (GraphRunBase & { phase: "transcribe"; params: ForgeParams })
  | (GraphRunBase & { phase: "structure-resolve"; params?: Partial<ForgeParams> });

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
  const runConfig = buildRunConfig(input.jobId, input.phase);

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
    beginGraphInvoke();
    try {
      const result = await graph.invoke(
        new Command({ resume: { decisions: resolveRaw?.decisions ?? [] } }),
        runConfig,
      );
      return isInterrupted(result) ? "needs_fix" : "done";
    } finally {
      endGraphInvoke();
    }
  }

  beginGraphInvoke();
  try {
    const result = await graph.invoke(
      { jobId: input.jobId, outDir: input.outDir, params: input.params },
      runConfig,
    );
    return isInterrupted(result) ? "needs_fix" : "done";
  } finally {
    endGraphInvoke();
  }
}

/**
 * 能否按 checkpoint 续跑：文件在 + 线程一致 + 拓扑版本一致 + 当前确实停在 reviewGate。
 * 任一不满足就降级 legacy —— 旧任务本来没有 checkpoint 文件，天然走到这里。
 */
async function canResume(
  jobId: string,
  graph: { getState: (config: RunnableConfig) => Promise<{ next?: string[] }> },
  saver: FileCheckpointSaver,
): Promise<boolean> {
  const head = await saver.inspect();
  if (!head.exists) return false;
  if (head.threadId !== jobId) return false;
  if (head.graphVersion !== GRAPH_VERSION) return false;

  const state = await graph.getState({ configurable: { thread_id: jobId } });
  return (state.next ?? []).includes("reviewGate");
}

/**
 * 组装 graph.invoke 的 config，唯一的追踪挂载点。
 *
 * 为什么只挂这里就够覆盖「图 + 每个节点 + 每次 LLM 生成」：LangChain 的
 * callbacks 会经 AsyncLocalStorage 向下继承（@langchain/core runnables/base.js
 * 的 runWithConfig），节点里的 `new ChatOpenAI().invoke()` 即使不显式传 config
 * 也会继承到这个 handler。反过来，下面 llm-client 的 legacy 兜底挂载是**互斥**的，
 * 不能同时生效，否则同一条 generation 会被上报两次（CallbackManager 不去重）。
 */
function buildRunConfig(jobId: string, phase: GraphPhase): RunnableConfig {
  const handler = newHandler({
    sessionId: jobId,
    tags: [`forge:${phase}`],
    metadata: { jobId, phase },
  });
  return {
    configurable: { thread_id: jobId },
    // Langfuse 用 runName 作为 trace 名字，方便在列表里区分阶段
    runName: `forge-${phase}`,
    ...(handler ? { callbacks: [handler] } : {}),
  };
}

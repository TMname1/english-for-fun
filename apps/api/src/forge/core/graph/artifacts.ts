/**
 * 图节点的磁盘 IO 层：每个方法对应一个 LangGraph 节点，只读/写既有产物文件，
 * 不感知 LangGraph。这样节点函数（nodes.ts）保持纯编排、artifacts 可单独测。
 *
 * 与 legacy（forge.ts 的命令式阶段函数）共用同一批原语：
 * prepareRun / transcribeRun / loadStructureInput / finalizeCourse / mergeResolveChains，
 * 两条路径的落盘结果必须逐字段一致。
 */
import { resolve } from "node:path";

import type { AlignmentReport } from "../align";
import type { DraftChain, StructureProgress } from "../types";
import type { StageEmitter } from "./events";
import type { ForgeStateType, ForgeStateUpdate } from "./state";
import { config } from "../config";
import {
  finalizeCourse,
  loadStructureInput,
  mergeResolveChains,
  paths,
  prepareRun,
  readJson,
  transcribeRun,
  writeJson,
} from "../forge";
import { generateDraftCollected } from "../llm";
import { preflightLlm } from "../preflight";

/** 允许的 resolve 轮次上限：防止前端反复重试把图跑成死循环 */
export const MAX_REVIEW_ROUNDS = 3;

/** 节点依赖的产物操作面：便于单测注入假实现（不碰磁盘/LLM） */
export interface ForgeArtifactSource {
  prepare(state: ForgeStateType): Promise<ForgeStateUpdate>;
  transcribe(state: ForgeStateType): Promise<ForgeStateUpdate>;
  structureBatch(state: ForgeStateType): Promise<ForgeStateUpdate>;
  retryBatch(state: ForgeStateType): Promise<ForgeStateUpdate>;
  finalize(state: ForgeStateType): Promise<ForgeStateUpdate>;
  readProgress(outDir: string): Promise<StructureProgress | null>;
}

export class ForgeArtifacts implements ForgeArtifactSource {
  constructor(private readonly emitStage: StageEmitter) {}

  /** 校验媒体 + 写 meta.json + 规整 clips（clips 规整结果回写 state，供 transcribe 用） */
  async prepare(state: ForgeStateType): Promise<ForgeStateUpdate> {
    const { mediaPath, title, type } = state.params;
    if (!mediaPath) throw new Error("[forge] 缺少媒体文件路径（FORGE_MEDIA_PATH）");
    if (!title) throw new Error("[forge] 缺少课程包标题（FORGE_TITLE）");

    const { outDir, clips } = await prepareRun({
      mediaPath,
      title,
      description: state.params.description,
      type,
      language: state.params.language,
      outDir: state.outDir,
      clips: state.params.clips,
    });

    return {
      outDir,
      stage: "transcoding",
      params: { ...state.params, mediaPath: resolve(mediaPath), clips: clips ?? undefined },
    };
  }

  /** 转码 → ASR → 预处理 → 写 transcript.json / transcript.raw.json / clips.json */
  async transcribe(state: ForgeStateType): Promise<ForgeStateUpdate> {
    const { transcript } = await transcribeRun({
      outDir: state.outDir,
      mediaPath: state.params.mediaPath!,
      clips: state.params.clips,
      language: state.params.language,
      onStage: this.emitStage,
    });

    return {
      stage: "transcribing",
      transcriptStat: {
        segments: transcript.segments.length,
        wordLevel: transcript.wordLevel,
        clipCount: state.params.clips?.length ?? 0,
      },
    };
  }

  /** 一句一调用结构化：全部成功进 finalize，有失败落盘进度快照后进 reviewGate */
  async structureBatch(state: ForgeStateType): Promise<ForgeStateUpdate> {
    const { transcript } = await loadStructureInput(state.outDir);
    this.emitStage("structuring");
    if (config.llmPreflight) {
      await preflightLlm();
    }

    const { chains, failures } = await generateDraftCollected(transcript);
    const statementCount = countStatements(chains);

    if (failures.length > 0) {
      await this.writeProgress(state.outDir, chains, failures);
      console.log(`[forge] 结构化有 ${failures.length} 句未通过校验，已落盘进度等待人工处理`);
      return {
        chains,
        statementCount,
        failureCount: failures.length,
        failureIndexes: failures.map((f) => f.index).sort((a, b) => a - b),
      };
    }

    console.log(
      `[forge] 结构化完成：1 课（单一课程，逐句并发生成的组装链已按句序合并）/ ${statementCount} 条 statement`,
    );
    return { chains, statementCount, failureCount: 0, failureIndexes: [] };
  }

  /**
   * 按人工决策续跑：只重跑 retry 句、丢弃 delete 句，与已成功句合并。
   * 合并源用磁盘上的 progress.success（与 legacy 一致），state.chains 只用于兜底。
   */
  async retryBatch(state: ForgeStateType): Promise<ForgeStateUpdate> {
    const { transcript } = await loadStructureInput(state.outDir);
    const progress = await this.readProgress(state.outDir);
    if (!progress) {
      throw new Error("[forge] 缺少结构化进度快照，无法处理失败句");
    }
    const decisions = state.decisions ?? [];
    const deleteIndexes = new Set(
      decisions.filter((d) => d.action === "delete").map((d) => d.index),
    );
    const retryIndexes = new Set(decisions.filter((d) => d.action === "retry").map((d) => d.index));

    this.emitStage("structuring");
    if (config.llmPreflight) {
      await preflightLlm();
    }

    let retriedChains: DraftChain[] = [];
    let newFailures: StructureProgress["failures"] = [];
    if (retryIndexes.size > 0) {
      const result = await generateDraftCollected(
        transcript,
        [...retryIndexes].sort((a, b) => a - b),
      );
      retriedChains = result.chains;
      newFailures = result.failures;
    }

    const merged = mergeResolveChains({
      success: progress.success,
      deleteIndexes,
      retryIndexes,
      retriedChains,
    });
    const failures = [...newFailures].sort((a, b) => a.index - b.index);

    if (failures.length > 0) {
      await this.writeProgress(state.outDir, merged, failures);
      console.log(`[forge] 处理后仍有 ${failures.length} 句未通过校验，已更新进度等待人工处理`);
      return {
        chains: merged,
        failureCount: failures.length,
        failureIndexes: failures.map((f) => f.index).sort((a, b) => a - b),
      };
    }

    if (merged.every((c) => c.statements.length === 0)) {
      throw new Error("[forge] 处理后没有任何句子，无法生成课程");
    }

    return { chains: merged, failureCount: 0, failureIndexes: [] };
  }

  /** 时间戳对齐 + 合成 course.json（复用 legacy 的 finalizeCourse） */
  async finalize(state: ForgeStateType): Promise<ForgeStateUpdate> {
    this.emitStage("aligning");
    const { meta, transcript } = await loadStructureInput(state.outDir);
    await finalizeCourse(state.outDir, transcript, meta, state.chains);
    const report = await this.readAlignment(state.outDir);
    this.emitStage("done");
    return {
      stage: "done",
      statementCount: countStatements(state.chains),
      alignRate: report?.rate ?? 0,
    };
  }

  async readProgress(outDir: string): Promise<StructureProgress | null> {
    try {
      return await readJson<StructureProgress>(paths.progress(outDir));
    } catch {
      return null;
    }
  }

  private async readAlignment(outDir: string): Promise<AlignmentReport | null> {
    try {
      return await readJson<AlignmentReport>(paths.alignment(outDir));
    } catch {
      return null;
    }
  }

  private async writeProgress(
    outDir: string,
    chains: DraftChain[],
    failures: StructureProgress["failures"],
  ): Promise<void> {
    const progress: StructureProgress = {
      success: chains.map((c) => ({ index: c.index, statements: c.statements, spans: c.spans })),
      failures,
    };
    await writeJson(paths.progress(outDir), progress);
  }
}

export function countStatements(chains: DraftChain[]): number {
  return chains.reduce((n, c) => n + c.statements.length, 0);
}

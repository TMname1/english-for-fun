/**
 * Course Forge GUI 流水线运行入口（被 apps/api 用 tsx 拉起）。
 *
 * 不是 CLI：直接 import 流水线函数调用，参数从 process.env 读取，避免 argv 转义 / 路径空格。
 *
 * 协议：
 *   stdout 仅写 JSON Lines（每行一个事件），父进程按 \n 切片解析
 *     { event: "stage", stage: "transcoding" | "transcribing" | "structuring" | "aligning" | "done" }
 *     { event: "done",  outDir: "<绝对路径>" }
 *     { event: "needs_fix", outDir: "<绝对路径>" }
 *     { event: "error", message: "<错误>" }
 *   流水线内部的 console.log/warn/error 一律劫持到 stderr，避免污染事件流。
 *
 * 编排层两套实现（FORGE_ORCHESTRATOR）：
 *   legacy（默认）—— forge.ts 的命令式阶段函数，行为与重构前完全一致；
 *   graph        —— LangGraph StateGraph：阶段 = 节点，needs_fix = interrupt，
 *                   resolve = Command({resume})，状态存在 outDir/graph.checkpoint.json。
 *   两套对外的 stdout 协议完全相同，切换只影响子进程内部。
 *
 * 环境变量：
 *   FORGE_PHASE       transcribe | structure | structure-resolve（必填）：
 *                     transcribe 跑「提取音轨 + ASR 转写」后【已停用转录校对：直接续跑结构化 + 对齐】；
 *                     structure 读 outDir 下（人工编辑过的）transcript.json 续跑「结构化 + 对齐」【现已停用，代码注释保留】；
 *                     structure-resolve 读进度快照与 resolve 决策，只重跑 retry 句后合并收尾
 *   FORGE_ORCHESTRATOR legacy | graph（缺省 legacy）
 *   FORGE_MEDIA_PATH  视频/音频绝对路径（transcribe 阶段必填）
 *   FORGE_TITLE       课程包标题（transcribe 阶段必填）
 *   FORGE_TYPE        dialogue | music（transcribe 阶段必填）
 *   FORGE_DESC        描述（可选）
 *   FORGE_LANGUAGE    ASR 语言提示：en | zh | ja（可选，默认 en；非法值直接报错）
 *   FORGE_OUT_DIR     产物目录绝对路径（必填，由调用方分配，避免与 CLI 模式 runId 冲突）
 *   FORGE_CLIPS       选中时间区间 JSON（可选，[{start,end}]，秒）；缺省转写整段
 */

import { basename } from "node:path";

import type { ForgeStage } from "./forge";
import type { ForgeLanguage } from "./graph/state";
import type { ClipRange } from "./types";
import { config } from "./config";
import { forgeStructureInteractive, forgeStructureResolve, forgeTranscribe } from "./forge";
import { runForgeGraph } from "./graph/run";
import { isForgeLanguage } from "./graph/state";
import { flushTracing } from "./tracing";

// 【已停用 · 转录校对】以下导入仅供 structure（人工编辑续跑）分支使用，该分支现已注释保留。
// 恢复"转录→校对→结构化"两段式时一并放开（见 main() 内说明）。
// import { readFile, writeFile } from "node:fs/promises";
// import { resolve } from "node:path";
// import { normalizeEditedTranscript } from "./transcript-edit";

console.log = (...args: unknown[]) => {
  process.stderr.write(args.map(String).join(" ") + "\n");
};
console.warn = console.log;
console.error = console.log;
console.info = console.log;
console.debug = console.log;

function emit(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`缺少环境变量 ${key}`);
  }
  return value;
}

function readClips(): ClipRange[] | undefined {
  if (!process.env.FORGE_CLIPS?.trim()) return undefined;
  const parsed = JSON.parse(process.env.FORGE_CLIPS) as ClipRange[];
  if (
    !Array.isArray(parsed) ||
    parsed.some((c) => !Number.isFinite(c?.start) || !Number.isFinite(c?.end))
  ) {
    throw new Error("FORGE_CLIPS 必须是 [{start,end}] 形式的 JSON 数组");
  }
  return parsed;
}

/**
 * 各阶段的入参。用可辨识联合表达「谁必填什么」：
 * - transcribe 必须给 mediaPath / title（缺了 prepare 必然失败，见 graph/state.ts 的 ForgeParams）；
 * - structure / structure-resolve 的 state 由 outDir 里的产物与 checkpoint 还原，不再要求媒体。
 *
 * 刻意写成扁平对象而不是 `Common & {...}` 交叉类型：交叉类型上的判别属性收窄不可靠，
 * 会让 `input.mediaPath` 在后面仍被判为「属性不存在」。
 */
type PhaseInput =
  | {
      phase: "transcribe";
      outDir: string;
      type: "dialogue" | "music";
      /** 源媒体绝对路径（FORGE_MEDIA_PATH，必填） */
      mediaPath: string;
      /** 课程包标题（FORGE_TITLE，必填） */
      title: string;
      description?: string;
      language: ForgeLanguage;
      clips?: ClipRange[];
    }
  | {
      phase: "structure" | "structure-resolve";
      outDir: string;
      /** 续跑阶段不写 meta.json，type 仅作占位 */
      type: "dialogue" | "music";
      description?: string;
      language: ForgeLanguage;
    };

/** 从环境变量汇总一次运行的入参（legacy 与 graph 两套编排共用） */
function readPhaseInput(): PhaseInput {
  const phaseRaw = process.env.FORGE_PHASE ?? "transcribe";
  const phase =
    phaseRaw === "structure" || phaseRaw === "structure-resolve" ? phaseRaw : "transcribe";
  const outDir = requireEnv("FORGE_OUT_DIR");
  const description = process.env.FORGE_DESC?.trim() || undefined;
  // 与 FORGE_TYPE 同样的做法：越早报错越好，别让拼错的语言代码跑到 ASR 才暴露
  const languageRaw = process.env.FORGE_LANGUAGE?.trim() || "en";
  if (!isForgeLanguage(languageRaw)) {
    throw new Error(`FORGE_LANGUAGE 必须是 en / zh / ja 之一，收到 ${languageRaw}`);
  }
  const language: ForgeLanguage = languageRaw;

  if (phase === "transcribe") {
    // 只有 transcribe 阶段需要 type（写进 meta.json）
    const raw = requireEnv("FORGE_TYPE");
    if (raw !== "dialogue" && raw !== "music") {
      throw new Error(`FORGE_TYPE 必须是 dialogue 或 music，收到 ${raw}`);
    }
    return {
      phase,
      outDir,
      type: raw,
      mediaPath: requireEnv("FORGE_MEDIA_PATH"),
      title: requireEnv("FORGE_TITLE"),
      description,
      language,
      clips: readClips(),
    };
  }

  // resolve 阶段保持宽容，与重构前一致
  return { phase, outDir, type: "dialogue", description, language };
}

/** 历史实现：命令式阶段函数串联（保留为一行回滚路径） */
async function runLegacyPhase(input: PhaseInput): Promise<void> {
  if (input.phase === "structure-resolve") {
    const result = await forgeStructureResolve({
      outDir: input.outDir,
      onStage: (stage) => emit({ event: "stage", stage }),
    });
    emit(
      result.needsFix
        ? { event: "needs_fix", outDir: input.outDir }
        : { event: "done", outDir: input.outDir },
    );
    return;
  }

  // 【已停用 · 转录校对】FORGE_PHASE=structure（人工编辑后续跑）──────────────────
  // 停用原因：当前流水线不再需要「转录后暂停 → 人工校对 → 回传 transcript.edited.json 续跑」
  //   这一步，转录子进程改为直接续跑结构化（见下方分支）。代码整段注释保留。
  // 恢复方法：① 放开本分支与顶部 readFile/writeFile/resolve/normalizeEditedTranscript 导入；
  //   ② 把下面分支里新增的 forgeStructureInteractive 串联改回 `emit({ event: "done", outDir: finalDir })`；
  //   ③ 恢复 forge.service.ts handleDone 的 awaiting_review 暂停、resumeJob 与前端 review 步骤。
  // if (input.phase === "structure") {
  //   const editsRaw = JSON.parse(await readFile(resolve(input.outDir, "transcript.edited.json"), "utf-8"));
  //   const transcript = normalizeEditedTranscript(
  //     editsRaw,
  //     process.env.FORGE_LANGUAGE?.trim() || "en",
  //   );
  //   await writeFile(
  //     resolve(input.outDir, "transcript.json"),
  //     `${JSON.stringify(transcript, null, 2)}\n`,
  //     "utf-8",
  //   );
  //   const result = await forgeStructureInteractive({
  //     outDir: input.outDir,
  //     onStage: (stage) => emit({ event: "stage", stage }),
  //   });
  //   emit(result.needsFix ? { event: "needs_fix", outDir: input.outDir } : { event: "done", outDir: input.outDir });
  // } else {
  if (input.phase !== "transcribe") {
    // 只剩 structure（已停用）：以前会带着 undefined 的 mediaPath 掉进转写里报错，现在直接说清楚。
    // 用 `!== "transcribe"` 而不是 `=== "structure"` 是因为联合成员的 phase 是字面量联合，
    // 否定式收窄才能把 transcribe 这一支单独留下（`=== "structure"` 只会收窄属性、不剔除成员）。
    throw new Error(
      "[forge] FORGE_PHASE=structure 已停用（转录校对两段式已下线）：请改用 transcribe 或 structure-resolve",
    );
  }

  // 走到这里只剩 transcribe：mediaPath / title 由 PhaseInput 联合类型强制必填
  const finalDir = await forgeTranscribe({
    mediaPath: input.mediaPath,
    title: input.title,
    type: input.type,
    description: input.description,
    language: input.language,
    outDir: input.outDir,
    clips: input.clips,
    onStage: (stage) => emit({ event: "stage", stage }),
  });
  // 【转录校对已停用】转录完成后不再暂停等待人工校对，直接在同一子进程内续跑结构化 + 对齐。
  // 恢复两段式时：删掉下面这段串联，改回 `emit({ event: "done", outDir: finalDir });`。
  const result = await forgeStructureInteractive({
    outDir: finalDir,
    onStage: (stage) => emit({ event: "stage", stage }),
  });
  emit(
    result.needsFix
      ? { event: "needs_fix", outDir: finalDir }
      : { event: "done", outDir: finalDir },
  );
  // }
}

/** LangGraph 编排：阶段 = 节点，needs_fix = interrupt；checkpoint 不可用时退回 legacy */
async function runGraphPhase(input: PhaseInput): Promise<void> {
  if (input.phase === "structure") {
    // 人工编辑续跑这条分支此前已停用，图里也没有对应节点 → 直接走 legacy（同样是抛错/跳过）
    console.warn("[forge] FORGE_PHASE=structure 未在图编排中实现，回退 legacy");
    return runLegacyPhase(input);
  }

  const jobId = basename(input.outDir);
  // fresh 与续跑的参数形状不同（见 GraphRunInput）：transcribe 必须给全，resolve 只给定位信息
  const outcome = await runForgeGraph(
    input.phase === "transcribe"
      ? {
          phase: "transcribe",
          jobId,
          outDir: input.outDir,
          params: {
            mediaPath: input.mediaPath,
            title: input.title,
            description: input.description,
            type: input.type,
            language: input.language,
            clips: input.clips,
          },
        }
      : { phase: "structure-resolve", jobId, outDir: input.outDir },
    (stage: ForgeStage) => emit({ event: "stage", stage }),
  );

  if (outcome === "unavailable") {
    // 旧任务 / 拓扑升级 / 未停在暂停点：退回命令式实现，语义与重构前一致
    return runLegacyPhase(input);
  }
  emit(
    outcome === "needs_fix"
      ? { event: "needs_fix", outDir: input.outDir }
      : { event: "done", outDir: input.outDir },
  );
}

async function main(): Promise<void> {
  try {
    const input = readPhaseInput();
    if (config.orchestrator === "graph") {
      await runGraphPhase(input);
    } else {
      await runLegacyPhase(input);
    }
    // Langfuse 的 span 是后台批量上报的，process.exit() 前必须把队列刷干净，
    // 否则最后一批（通常是 finalize 和收尾的 LLM 调用）会直接丢失。
    await flushTracing();
    process.exit(0);
  } catch (error) {
    emit({ event: "error", message: error instanceof Error ? error.message : String(error) });
    await flushTracing();
    process.exit(1);
  }
}

main();

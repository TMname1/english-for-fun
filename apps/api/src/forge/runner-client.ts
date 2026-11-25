import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { ForgeJobStage } from "./job-store";

const STDERR_BUFFER_MAX = 5 * 1024;
const STDERR_TAIL_FOR_ERROR = 600;

/** 编译后 runner-client.js 与 core/ 是兄弟目录；dev（nest start --watch）与 prod 同为 dist/src/forge/ */
const RUNNER_ENTRY = join(__dirname, "core", "pipeline-runner.js");
/** 流水线本地临时工作区（ffmpeg/ASR 必须操作本地文件）；持久产物在对象存储 forge/<jobId>/ */
export const FORGE_OUTPUT_ROOT = join(tmpdir(), "earthworm-forge");

/**
 * 子进程入参。按阶段做可辨识联合，把真正必填的字段钉在类型上：
 * - transcribe：mediaPath / title / type / outDir 必填（缺任一项子进程启动即失败）；
 * - structure / structure-resolve：只读 outDir 下的产物与 checkpoint，媒体信息不需要。
 */
export type ForgeRunnerParams =
  | {
      phase: "transcribe";
      /** 源媒体绝对路径（ffmpeg / ASR 读本地文件） */
      mediaPath: string;
      /** 课程包标题，写进 meta.json */
      title: string;
      type: "dialogue" | "music";
      outDir: string;
      language?: string;
      description?: string;
      /** 选中的时间区间（秒）；缺省转写整段 */
      clips?: { start: number; end: number }[];
    }
  | {
      phase: "structure" | "structure-resolve";
      outDir: string;
      language?: string;
      description?: string;
      type?: "dialogue" | "music";
    };

export interface ForgeRunnerEvents {
  onStage: (stage: ForgeJobStage) => void;
  onDone: (outDir: string) => void;
  onNeedsFix: (outDir: string) => void;
  onError: (message: string) => void;
}

export interface ForgeRunnerHandle {
  child: ChildProcessWithoutNullStreams;
  pid?: number;
  kill: () => void;
}

interface RunnerEventPayload {
  event?: "stage" | "done" | "needs_fix" | "error";
  stage?: ForgeJobStage;
  outDir?: string;
  message?: string;
}

/**
 * 起一个 node 子进程跑编译产物 core/pipeline-runner.js。
 * 子进程 stdout 走 JSON Lines 事件协议，stderr 是 forgeMake 内部的 console 日志（劫持过）。
 */
export function spawnForgeRunner(
  params: ForgeRunnerParams,
  events: ForgeRunnerEvents,
): ForgeRunnerHandle {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORGE_PHASE: params.phase,
    FORGE_OUT_DIR: params.outDir,
  };
  if (params.phase === "transcribe") {
    env.FORGE_MEDIA_PATH = params.mediaPath;
    env.FORGE_TITLE = params.title;
    env.FORGE_TYPE = params.type;
    if (params.description) env.FORGE_DESC = params.description;
    if (params.language) env.FORGE_LANGUAGE = params.language;
    if (params.clips?.length) env.FORGE_CLIPS = JSON.stringify(params.clips);
  }

  const child = spawn(process.execPath, [RUNNER_ENTRY], {
    env,
  }) as ChildProcessWithoutNullStreams;

  let stdoutBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let idx = stdoutBuffer.indexOf("\n");
    while (idx !== -1) {
      const line = stdoutBuffer.slice(0, idx).trim();
      stdoutBuffer = stdoutBuffer.slice(idx + 1);
      idx = stdoutBuffer.indexOf("\n");
      if (!line) continue;
      handleStdoutLine(line, events);
    }
  });

  const stderrChunks: string[] = [];
  let stderrLength = 0;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    // 实时透传：子进程把 console 劫持到了 stderr，这里不转发的话，任务"卡住"时父进程
    // 完全看不到它在干什么（旧实现只留最后 600 字，且只在退出时才用）。多行 chunk 按行拆。
    for (const line of chunk.split(/\r?\n/)) {
      const text = line.trim();
      if (text) console.log(`[forge:${params.phase}] ${text}`);
    }
    stderrChunks.push(chunk);
    stderrLength += chunk.length;
    while (stderrLength > STDERR_BUFFER_MAX && stderrChunks.length > 1) {
      stderrLength -= stderrChunks.shift()!.length;
    }
  });

  child.on("error", (err) => {
    events.onError(`无法启动流水线子进程：${err.message}`);
  });

  child.on("exit", (code, signal) => {
    const remaining = stdoutBuffer.trim();
    if (remaining) handleStdoutLine(remaining, events);
    stdoutBuffer = "";
    if (code === 0) return;
    const tail = stderrChunks.join("").slice(-STDERR_TAIL_FOR_ERROR).trim();
    const reason =
      signal === "SIGTERM" || signal === "SIGKILL" ? "任务已取消" : tail || `进程退出码 ${code}`;
    events.onError(reason);
  });

  return {
    child,
    pid: child.pid,
    kill: () => {
      if (!child.killed) child.kill("SIGTERM");
    },
  };
}

function handleStdoutLine(line: string, events: ForgeRunnerEvents): void {
  let payload: RunnerEventPayload;
  try {
    payload = JSON.parse(line) as RunnerEventPayload;
  } catch {
    return;
  }
  switch (payload.event) {
    case "stage":
      if (payload.stage) events.onStage(payload.stage);
      break;
    case "done":
      if (payload.outDir) events.onDone(payload.outDir);
      break;
    case "needs_fix":
      if (payload.outDir) events.onNeedsFix(payload.outDir);
      break;
    case "error":
      events.onError(payload.message ?? "流水线报错");
      break;
    default:
      break;
  }
}

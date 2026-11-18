import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { ForgeJobStage } from "./job-store";

const STDERR_BUFFER_MAX = 5 * 1024;
const STDERR_TAIL_FOR_ERROR = 600;

/** 向上查找 pnpm-workspace.yaml 定位 monorepo 根，apps/api 的 process.cwd() 通常在 apps/api/ 下 */
function findRepoRoot(): string {
  if (process.env.FORGE_REPO_ROOT) return process.env.FORGE_REPO_ROOT;
  let dir = resolve(process.cwd());
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(process.cwd(), "..", "..");
}

export const REPO_ROOT = findRepoRoot();
export const FORGE_PKG_DIR = join(REPO_ROOT, "packages", "course-forge");
/** 流水线本地临时工作区（ffmpeg/ASR 必须操作本地文件）；持久产物在对象存储 forge/<jobId>/ */
export const FORGE_OUTPUT_ROOT = join(tmpdir(), "earthworm-forge");

export interface ForgeRunnerParams {
  /** transcribe：跑「提取音轨 + ASR 转写」后暂停；structure：读 outDir 下编辑过的 transcript 续跑 */
  phase: "transcribe" | "structure";
  /** transcribe 阶段必填；structure 阶段不需要 */
  mediaPath?: string;
  title?: string;
  type?: "dialogue" | "music";
  description?: string;
  language?: string;
  outDir: string;
  /** 选中的时间区间（秒）；缺省转写整段 */
  clips?: { start: number; end: number }[];
}

export interface ForgeRunnerEvents {
  onStage: (stage: ForgeJobStage) => void;
  onDone: (outDir: string) => void;
  onError: (message: string) => void;
}

export interface ForgeRunnerHandle {
  child: ChildProcessWithoutNullStreams;
  pid?: number;
  kill: () => void;
}

interface RunnerEventPayload {
  event?: "stage" | "done" | "error";
  stage?: ForgeJobStage;
  outDir?: string;
  message?: string;
}

/**
 * 用 tsx 起一个子进程跑 packages/course-forge/src/pipeline-runner.ts。
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

  const child = spawn("pnpm", ["exec", "tsx", "src/pipeline-runner.ts"], {
    cwd: FORGE_PKG_DIR,
    env,
    shell: process.platform === "win32",
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
    case "error":
      events.onError(payload.message ?? "流水线报错");
      break;
    default:
      break;
  }
}

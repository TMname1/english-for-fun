import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const repoRoot = resolve(packageDir, "..", "..");

/** 解析 .env 文本为键值对（纯函数）：KEY=VALUE，支持引号与 # 注释；非法行跳过 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quoted = value.match(/^(["'])([\s\S]*)\1$/);
    if (quoted) {
      value = quoted[2];
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/** 加载包目录下的 .env（存在才读）；进程环境变量优先，不会被文件覆盖 */
function loadDotEnv(): void {
  const file = join(packageDir, ".env");
  if (!existsSync(file)) return;
  for (const [key, value] of Object.entries(parseDotEnv(readFileSync(file, "utf-8")))) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
loadDotEnv();

function env(key: string, fallback: string): string {
  // 显式设置的空串也是有效值（如 FORGE_LLM_REASONING_EFFORT= 表示不发送该字段）；未设置才用默认
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  return raw.trim();
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  packageDir,
  defaultOutRoot: join(packageDir, "output"),

  /** ASR（docker-compose 的 asr 服务，OpenAI 兼容接口） */
  asrBaseUrl: env("FORGE_ASR_URL", "http://localhost:9000"),
  /** docker compose 拉起 asr 服务后的等待上限（首次要拉镜像 + 下载模型） */
  asrWaitMs: envInt("FORGE_ASR_WAIT_MS", 15 * 60 * 1000),

  /** LLM（OpenAI 兼容 chat completions；默认本地 ollama） */
  llmBaseUrl: env("FORGE_LLM_BASE_URL", "http://localhost:11434/v1"),
  llmModel: env("FORGE_LLM_MODEL", "qwen3:4b"),
  llmApiKey: env("FORGE_LLM_API_KEY", "ollama"),
  llmMaxTokens: envInt("FORGE_LLM_MAX_TOKENS", 16000),
  /** OpenAI 兼容端点的 reasoning_effort；ollama 上 "none" 可关闭 qwen3 思考（思考会吃光 max_tokens 并把生成拖过 undici 300s 超时）。设为空串（如 .env 里 `FORGE_LLM_REASONING_EFFORT=`）则不发送该字段——DashScope 等非 ollama 服务必须置空 */
  llmReasoningEffort: env("FORGE_LLM_REASONING_EFFORT", "none"),
  /** 单次 LLM 调用携带的最大转写词数：一个分块恰好生成一门课，分块大小≈课程规模（约 5~15 个目标句） */
  llmMaxWordsPerCall: envInt("FORGE_LLM_MAX_WORDS", 250),
  /** 转写结束后自动停止 asr 容器，把显存让给 LLM（0 = 保持常驻，可加快下次转写） */
  asrStopAfterTranscribe: env("FORGE_ASR_STOP_AFTER", "1") !== "0",
  /** LLM 调用前是否预检（服务连通 / 模型存在 / 显存余量） */
  llmPreflight: env("FORGE_LLM_PREFLIGHT", "1") !== "0",
  /** 显存估算不足时是否直接拦停（0 = 仅警告，接受 CPU 卸载慢跑） */
  llmVramStrict: env("FORGE_LLM_VRAM_STRICT", "1") !== "0",
  /** 显存估算余量：KV cache + CUDA 上下文开销（MB） */
  llmVramMarginMb: envInt("FORGE_LLM_VRAM_MARGIN_MB", 512),

  /** 导入目标：earthworm API */
  apiBaseUrl: env("FORGE_API_URL", "http://localhost:3001"),
  /** API 的课程视频静态目录（挂到 /course-video）；导入时把视频复制到这里 */
  courseVideoDir: env(
    "FORGE_COURSE_VIDEO_DIR",
    join(repoRoot, "apps", "api", "storage", "course-video"),
  ),
} as const;

export function createRunId(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

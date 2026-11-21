import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

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

/** 加载 cwd（约定为 apps/api）下的 .env；进程环境变量优先，不会被文件覆盖。
 * Nest 场景 env 已由 ConfigModule 注入，这里只是 CLI/probe 直跑时的兜底。 */
function loadDotEnv(): void {
  const file = resolve(process.cwd(), process.env.NODE_ENV === "prod" ? ".env.prod" : ".env");
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

/** 解析思考开关：空串/未设置 -> undefined（不发送字段）；false/0 -> false；true/1 -> true */
export function parseEnableThinking(raw: string): boolean | undefined {
  const v = raw.trim().toLowerCase();
  if (v === "false" || v === "0") return false;
  if (v === "true" || v === "1") return true;
  return undefined;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  defaultOutRoot: join(process.cwd(), "output"),

  /** ASR（阿里云百炼 DashScope 非实时语音识别 Qwen-Audio-ASR：原生 multimodal-generation 接口，同步返回句/词级毫秒时间戳） */
  asrBaseUrl: env(
    "FORGE_ASR_BASE_URL",
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
  ),
  asrModel: env("FORGE_ASR_MODEL", "qwen-audio-3.1-asr-flash"),
  /** 百炼 DashScope API Key（sk- 开头）；与 LLM 解耦，单独配置 */
  asrApiKey: env("FORGE_ASR_API_KEY", ""),
  /** 单次转写请求超时（毫秒）；同步等待完整结果，长音频耗时较长，默认 3 分钟 */
  asrTimeoutMs: envInt("FORGE_ASR_TIMEOUT_MS", 3 * 60 * 1000),

  /** LLM（OpenAI 兼容 chat completions；默认本地 ollama） */
  llmBaseUrl: env("FORGE_LLM_BASE_URL", "http://localhost:11434/v1"),
  /** 句子分析（结构化组装链）模型 */
  llmModel: env("FORGE_LLM_MODEL", "tongyi-xiaomi-analysis-flash"),
  /** 预处理（拆句）模型；与句子分析模型分开配置，共用 base URL / API Key */
  preprocessModel: env("FORGE_PREPROCESS_MODEL", "qwen3.8-flash"),
  llmApiKey: env("FORGE_LLM_API_KEY", "ollama"),
  llmMaxTokens: envInt("FORGE_LLM_MAX_TOKENS", 16000),
  /** OpenAI 兼容端点的 reasoning_effort；ollama 上 "none" 可关闭 qwen3 思考（思考会吃光 max_tokens 并把生成拖过 undici 300s 超时）。设为空串（如 .env 里 `FORGE_LLM_REASONING_EFFORT=`）则不发送该字段——DashScope 等非 ollama 服务必须置空 */
  llmReasoningEffort: env("FORGE_LLM_REASONING_EFFORT", "none"),
  /** DashScope 等端点的思考开关（enable_thinking）：qwen3.8-flash 等新模型默认开思考，思考文本不计入正文却吃 max_tokens，会把结构化拖成"假卡死"。未设置/空串 = 不发送该字段（ollama 等不认识它的服务保持兼容） */
  llmEnableThinking: parseEnableThinking(env("FORGE_LLM_ENABLE_THINKING", "")),
  /** 一句一调用的并发上限：同时发起多少个句子的模型调用（不是把多少句丢给一次调用） */
  llmConcurrency: envInt("FORGE_LLM_CONCURRENCY", 10),
  /** LLM 调用前是否预检（服务连通 / 模型存在 / 显存余量） */
  llmPreflight: env("FORGE_LLM_PREFLIGHT", "1") !== "0",
  /** 显存估算不足时是否直接拦停（0 = 仅警告，接受 CPU 卸载慢跑） */
  llmVramStrict: env("FORGE_LLM_VRAM_STRICT", "1") !== "0",
  /** 显存估算余量：KV cache + CUDA 上下文开销（MB） */
  llmVramMarginMb: envInt("FORGE_LLM_VRAM_MARGIN_MB", 512),

  /** 导入目标：earthworm API */
  apiBaseUrl: env("FORGE_API_URL", "http://localhost:3001"),
  /** API 单用户登录凭证（与 apps/api/.env 的 AUTH_USERNAME/AUTH_PASSWORD 一致），导入前自动登录 */
  authUsername: env("AUTH_USERNAME", ""),
  authPassword: env("AUTH_PASSWORD", ""),
} as const;

export function createRunId(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

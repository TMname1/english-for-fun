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
  /** 单次转写请求超时（毫秒）；同步等待完整结果。默认 5 分钟：转写子图按 ≤180s 切块，3 分钟超时对高峰期偏紧 */
  asrTimeoutMs: envInt("FORGE_ASR_TIMEOUT_MS", 5 * 60 * 1000),

  /**
   * 音频打标（captioner）：异步任务接口，用于拿句级时间戳给切块提供边界。
   * 端点与 ASR 同源（百炼 workspace 域名），但模型/Key 可独立配置。
   */
  captionerBaseUrl: env("FORGE_CAPTIONER_BASE_URL", ""),
  captionerModel: env("FORGE_CAPTIONER_MODEL", "qwen-audio-3.1-captioner"),
  /** 留空时回退 FORGE_ASR_API_KEY（同一 workspace 的 Key 通常是同一把） */
  captionerApiKey: env("FORGE_CAPTIONER_API_KEY", ""),
  /** 单次 HTTP 请求超时（getPolicy / 提交 / 查询 / 下载），毫秒 */
  captionerTimeoutMs: envInt("FORGE_CAPTIONER_TIMEOUT_MS", 60 * 1000),
  captionerPollIntervalMs: envInt("FORGE_CAPTIONER_POLL_INTERVAL_MS", 3000),
  /** 轮询总超时；必须小于 service 的 job 超时（30 分钟），默认 10 分钟 */
  captionerPollTimeoutMs: envInt("FORGE_CAPTIONER_POLL_TIMEOUT_MS", 10 * 60 * 1000),

  /** 转写子图的块上限（秒）：asr-flash 同步接口上限 300s，留出 padding 余量 */
  asrChunkSeconds: envInt("FORGE_ASR_CHUNK_SECONDS", 180),
  /** 块音频前后各留的 padding（毫秒）：避免把词头词尾切掉 */
  asrChunkPadMs: envInt("FORGE_ASR_CHUNK_PAD_MS", 200),
  /** 块级 ASR 并发上限：DashScope 同步 ASR 对并发敏感，保守取 3 */
  asrConcurrency: envInt("FORGE_ASR_CONCURRENCY", 3),
  /** 1 = 成功后也保留 .work（块音频/逐块结果），用于排查切块与时间对齐问题 */
  keepWork: env("FORGE_KEEP_WORK", "0") === "1",

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

  /**
   * 编排层实现：graph（LangGraph StateGraph，默认）| legacy（重构前的命令式阶段函数）。
   * 出问题时设 FORGE_ORCHESTRATOR=legacy 即可回滚（运行时环境变量，无需重新构建）；
   * 旧任务没有 graph.checkpoint.json 时会自动降级 legacy，不依赖这个开关。
   */
  orchestrator: (env("FORGE_ORCHESTRATOR", "graph") === "legacy" ? "legacy" : "graph") as
    | "graph"
    | "legacy",
  /** 文件 checkpointer 每个线程保留的 checkpoint 份数（含最近的中断态，必须 >= 2） */
  checkpointKeep: envInt("FORGE_GRAPH_CHECKPOINT_KEEP", 8),

  /**
   * Langfuse 追踪：本地自托管（http://localhost:3002）或 Langfuse Cloud。
   * PUBLIC/SECRET 任一为空则整条追踪链路自动禁用（fail-open，不影响流水线）。
   * LANGFUSE_TRACING=0 可强制关闭，用于排障时排除追踪干扰。
   */
  langfuseEnabled: env("LANGFUSE_TRACING", "1") !== "0",
  langfusePublicKey: env("LANGFUSE_PUBLIC_KEY", ""),
  langfuseSecretKey: env("LANGFUSE_SECRET_KEY", ""),
  langfuseBaseUrl: env("LANGFUSE_BASE_URL", "https://cloud.langfuse.com"),
  /** 环境标识（Langfuse 里按 environment 过滤） */
  langfuseEnvironment: env("LANGFUSE_TRACING_ENVIRONMENT", "development"),

  /**
   * Langfuse Prompt Management：提示词托管在 Langfuse，运行时按 label 拉取。
   * 复用上面的 PUBLIC/SECRET/BASE_URL；LANGFUSE_PROMPTS=0 可单独关掉提示词托管
   * （只关拉取，不影响追踪）。拉取失败一律回退到代码里的本地常量（fail-open）。
   */
  langfusePromptsEnabled: env("LANGFUSE_PROMPTS", "1") !== "0",
  /** 拉哪个 label（Langfuse 概念：production / latest / 自定义） */
  langfusePromptLabel: env("LANGFUSE_PROMPT_LABEL", "production"),
  /** 进程内提示词缓存时长（毫秒）：一次任务只拉一次，改完提示词也无需重启即可生效 */
  langfusePromptCacheTtlMs: envInt("LANGFUSE_PROMPT_CACHE_TTL_MS", 60_000),
  /** 句子分析（组装链）提示词在 Langfuse 中的名字 */
  sentencePromptName: env("FORGE_PROMPT_SENTENCE_NAME", "forge-sentence-chain"),
  /** 预处理（拆句）提示词在 Langfuse 中的名字 */
  preprocessPromptName: env("FORGE_PROMPT_PREPROCESS_NAME", "forge-preprocess-split"),
} as const;

export function createRunId(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

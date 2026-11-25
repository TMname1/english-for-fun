/**
 * Langfuse Prompt Management 接入层（文本提示词）。
 *
 * 目标：把「一句一调用」的系统提示词与「预处理拆句」的系统提示词托管到 Langfuse，
 * 让改提示词不必改代码、不必重新构建；代码只保留同一份文本作为**本地兜底**。
 *
 * 设计约束（与 tracing.ts 同风格）：
 *   1. **fail-open**：未配置 key / 拉取失败 / 返回结构不对，一律退回本地常量，
 *      绝不因为「提示词服务」把流水线搞挂；
 *   2. **进程内缓存**：一次任务会发起与句子数等量的调用，只在首次（或 TTL 过期后）
 *      拉一次；拉取失败时若有旧缓存则继续用旧值（stale-while-error）；
 *   3. **只在有版本号时关联追踪**：`isFallback` 的提示词不写进 trace，
 *      避免把「本地兜底」误标成某个 Langfuse 版本；
 *   4. 只支持 text 类型提示词；chat 类型（消息数组）无法直接塞进当前「单条 system」结构，
 *      遇到时告警并兜底。
 *
 * 变量：提示词里写 `{{var}}` 时由 `compilePrompt` 替换，未提供的占位符原样保留
 * （两个内置提示词目前都**不带**变量，动态内容一律放在 user 消息里）。
 */
import { propagateAttributes } from "@langfuse/tracing";

import { config } from "./config";

export interface ManagedPrompt {
  /** 编译变量后的提示词正文 */
  text: string;
  /** Langfuse 中的提示词名字（本地兜底时也带上，便于日志定位） */
  name: string;
  /** Langfuse 版本号；本地兜底为 null */
  version: number | null;
  /** 是否是本地兜底（true 时不关联 trace） */
  isFallback: boolean;
}

interface RemotePrompt {
  text: string;
  version: number;
}

export type PromptFetcher = (name: string) => Promise<RemotePrompt>;

interface CacheEntry {
  text: string;
  version: number;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** 拉取超时：提示词服务不可达时必须快速兜底，不能拖住流水线 */
const FETCH_TIMEOUT_MS = 3000;

/** 单测用：清空缓存与自定义 fetcher */
export function resetPromptCacheForTest(): void {
  cache.clear();
  fetcherOverride = null;
}

let fetcherOverride: PromptFetcher | null = null;

/** 单测用：替换远端拉取实现（传 null 恢复真实 HTTP） */
export function setPromptFetcherForTest(fetcher: PromptFetcher | null): void {
  fetcherOverride = fetcher;
}

/** 是否具备远端拉取条件（配了 key 且没被 LANGFUSE_PROMPTS=0 关掉）。纯读配置 */
export function promptRemoteEnabled(): boolean {
  return Boolean(
    config.langfusePromptsEnabled && config.langfusePublicKey && config.langfuseSecretKey,
  );
}

/** 把 `{{name}}` 替换为 vars 里的值；未提供的占位符保留原样 */
export function compilePrompt(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  );
}

/**
 * 调 Langfuse 公开 API 拉一条文本提示词。
 *
 * 端点：`GET {baseUrl}/api/public/v2/prompts/{name}?label={label}`
 * 认证：HTTP Basic，用户名=public key，密码=secret key。
 * 返回体形如 `{ name, version, type: "text", prompt: "...", config, labels }`。
 */
async function fetchTextPromptRemote(name: string): Promise<RemotePrompt> {
  const base = config.langfuseBaseUrl.replace(/\/+$/, "");
  const url =
    `${base}/api/public/v2/prompts/${encodeURIComponent(name)}` +
    `?label=${encodeURIComponent(config.langfusePromptLabel)}`;
  const auth = Buffer.from(`${config.langfusePublicKey}:${config.langfuseSecretKey}`).toString(
    "base64",
  );

  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as {
    type?: string;
    prompt?: unknown;
    version?: number;
  };
  if (body.type !== "text" || typeof body.prompt !== "string" || !body.prompt.trim()) {
    throw new Error(`不是可用的 text 提示词（type=${String(body.type)}）`);
  }
  return { text: body.prompt, version: typeof body.version === "number" ? body.version : 0 };
}

/**
 * 取一条提示词：远端优先，失败/未启用时用本地兜底。
 * 永不抛错（除非 fallbackText 本身为空，那是编码错误）。
 */
export async function getManagedPrompt(
  name: string,
  fallbackText: string,
  opts: { vars?: Record<string, string | number>; forceEnabled?: boolean } = {},
): Promise<ManagedPrompt> {
  const fallback: ManagedPrompt = {
    text: compilePrompt(fallbackText, opts.vars),
    name,
    version: null,
    isFallback: true,
  };

  const enabled = opts.forceEnabled ?? promptRemoteEnabled();
  if (!enabled) return fallback;

  const now = Date.now();
  const cached = cache.get(name);
  if (cached && cached.expiresAt > now) {
    return {
      text: compilePrompt(cached.text, opts.vars),
      name,
      version: cached.version,
      isFallback: false,
    };
  }

  try {
    const fetcher = fetcherOverride ?? fetchTextPromptRemote;
    const remote = await fetcher(name);
    cache.set(name, {
      text: remote.text,
      version: remote.version,
      expiresAt: now + config.langfusePromptCacheTtlMs,
    });
    return {
      text: compilePrompt(remote.text, opts.vars),
      name,
      version: remote.version,
      isFallback: false,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (cached) {
      // stale-while-error：远端临时不可用时，旧版本比本地常量更接近线上真实配置
      console.warn(`[prompt] 拉取 ${name} 失败（${detail}），继续使用缓存版本 v${cached.version}`);
      return {
        text: compilePrompt(cached.text, opts.vars),
        name,
        version: cached.version,
        isFallback: false,
      };
    }
    console.warn(`[prompt] 拉取 ${name} 失败（${detail}），改用本地兜底提示词`);
    return fallback;
  }
}

/**
 * 在「已关联提示词版本」的上下文中执行一次调用。
 *
 * LangfuseSpanProcessor.onStart 会从父上下文读取传播属性，因此这段时间内创建的
 * generation span 会自动带上 prompt name/version，Langfuse 界面即可看到
 * 「这条 trace 用的是哪个版本的提示词」。本地兜底（无版本号）时直接执行，不写属性。
 */
export function withPrompt<T>(prompt: ManagedPrompt, fn: () => Promise<T>): Promise<T> {
  if (prompt.version === null) return fn();
  return propagateAttributes(
    { prompt: { name: prompt.name, version: prompt.version, isFallback: prompt.isFallback } },
    fn,
  );
}

/**
 * Langfuse Prompt Management 接入层（文本提示词）—— `@langfuse/client` 的薄适配器。
 *
 * 取模板、进程内缓存、变量渲染全部交给官方 SDK：
 *
 *   client.prompt.get(name, { type: "text", label, cacheTtlSeconds, fetchTimeoutMs, maxRetries })
 *     → TextPromptClient.compile(vars)   // Mustache（SDK 已把 mustache.escape 置为恒等函数）
 *
 * 本层只保留 SDK 不提供、而我们必须有的四件事：
 *
 *   1. **fail-open**：未配 key / 拉取失败 / 类型不符 / 版本非法 / 缺变量，一律回退代码里的本地常量，
 *      绝不因为「提示词服务」把流水线搞挂；
 *   2. **必需变量校验**：远端模板缺 `requiredVars` 里的任何一个，就当作不可用并回退，
 *      避免「Langfuse 里还是旧版无变量提示词」时把没有输入的提示词发给模型；
 *   3. **版本必须是正整数**：Langfuse 的观测关联只认 `name + 正整数 version`
 *      （`langfuse.observation.prompt.name` / `.version`）。0 / 浮点会让 prompt 详情页的
 *      “Number of Observations” 恒为 0 且没有任何报错；
 *   4. **可观测**：中文日志（每 name 只报一次）+ trace metadata
 *      （`prompt_name/prompt_version/prompt_source/prompt_label`）。
 *
 * 与旧实现的差异（有意为之，已确认接受）：
 *   - 变量用 Mustache 渲染：**未提供的变量渲染为空串**（旧实现保留 `{{x}}`）；
 *   - **没有 stale 标记**：SDK 缓存过期后先返回旧值、后台刷新，调用方无法感知；
 *     刷新失败只打一条 SDK 英文 warn；
 *   - SDK 冷失败时会先 `logger.error` 一条英文再抛错，这里用「单飞 + 30s 负缓存」
 *     把它压到每 name 每窗口最多一条。
 *
 * 形态约束不变：调用方只发**一条 system 消息**，静态指令在 Langfuse 的 Text 提示词里，
 * 动态内容用 `{{变量}}` 注入；变量区统一放在末尾（静态前缀逐字一致才能命中 provider 前缀缓存）。
 */
import { LangfuseClient, TextPromptClient } from "@langfuse/client";
import { propagateAttributes } from "@langfuse/tracing";

import { config } from "./config";
import { ensureTracingStarted } from "./tracing";

export type PromptVars = Record<string, string | number>;

/** 空值哨兵：Text 提示词没有条件语法，用「（无）」表达「本次没有这个值」 */
export const PROMPT_EMPTY = "（无）";

export interface ManagedPrompt {
  /** 未替换变量的原文（重试时要用同一版本、不同变量重新编译） */
  template: string;
  /** 按本次变量编译后的正文 */
  text: string;
  /** Langfuse 中的提示词名字（本地兜底时也带上，便于日志定位） */
  name: string;
  /** Langfuse 版本号（正整数）；本地兜底为 null */
  version: number | null;
  /** 是否是本地兜底（true 时不关联 trace） */
  isFallback: boolean;
  /** 日志/trace 用的来源标记 */
  source: "remote" | "fallback";
  /** 本次使用的 label（兜底时也带配置值） */
  label: string;
}

/** `TextPromptClient` 构造函数入参（避免直接 import `@langfuse/core` 的类型） */
type TextPromptData = ConstructorParameters<typeof TextPromptClient>[0];

/** 传给 `client.prompt.get` 的选项；单独成类型便于单测断言与注入 */
export interface PromptGetOptions {
  type: "text";
  label: string;
  cacheTtlSeconds: number;
  fetchTimeoutMs: number;
  maxRetries: number;
}

/** 单测缝：默认走 `LangfuseClient.prompt.get`，测试可注入不联网的实现 */
export type PromptGetter = (name: string, options: PromptGetOptions) => Promise<TextPromptClient>;

/** 拉取超时：提示词服务不可达时必须快速兜底，不能拖住流水线（SDK 默认 5s × 3 次） */
const PROMPT_FETCH_TIMEOUT_MS = 3000;

/** 失败后的负缓存窗口：一次课程会并发发起 N 句，避免 N 次失败 HTTP / N 条英文日志 */
const NEGATIVE_TTL_MS = 30_000;

let client: LangfuseClient | null = null;
let getterOverride: PromptGetter | null = null;

const inflight = new Map<string, Promise<TextPromptClient>>();
const failedUntil = new Map<string, number>();

/** 一次性告警/日志的去重键（name:reason），避免每句调用都刷屏 */
const warned = new Set<string>();
const logged = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

function logOnce(key: string, message: string): void {
  if (logged.has(key)) return;
  logged.add(key);
  console.log(message);
}

/** 配置类问题用 error 级别，但同样只报一次：一句一次调用 + N 句会让日志刷屏 */
function errorOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.error(message);
}

/** 单测用：清空客户端/注入/负缓存/日志去重 */
export function resetPromptCacheForTest(): void {
  client = null;
  getterOverride = null;
  inflight.clear();
  failedUntil.clear();
  warned.clear();
  logged.clear();
}

/** 单测用：替换「取提示词」实现（传 null 恢复真实 SDK） */
export function setPromptGetterForTest(getter: PromptGetter | null): void {
  getterOverride = getter;
}

/** 是否具备远端拉取条件（配了 key 且没被 LANGFUSE_PROMPTS=0 关掉）。纯读配置 */
export function promptRemoteEnabled(): boolean {
  return Boolean(
    config.langfusePromptsEnabled && config.langfusePublicKey && config.langfuseSecretKey,
  );
}

/**
 * 毫秒 → SDK 的秒级 TTL。
 * `<= 0` 表示禁用缓存（调试用）；正数向上取整，最小 1 秒（SDK 只支持秒）。
 */
export function toCacheTtlSeconds(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.max(1, Math.ceil(ms / 1000));
}

/** 变量占位符：Langfuse 只允许字母/数字/下划线，这里同步收紧 */
const PROMPT_VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * Mustache 控制语法：只允许 `{{变量}}` 插值，section/partial/comment/delimiter/triple/`&`
 * 一律拒绝。提示词由人在 Langfuse 后台编辑，一个误写的 `{{#x}}` 会改变渲染结构，
 * 一个未闭合的 `{{` 会让 Mustache 直接抛 `Unclosed tag`。
 */
const MUSTACHE_CONTROL_RE = /\{\{\{|\{\{\s*[#^/>!={&]/;

/** SDK 的 compile 只接受字符串值；数字统一转字符串（输出与旧实现一致） */
function toMustacheVars(vars: PromptVars): Record<string, string> {
  return Object.fromEntries(Object.entries(vars).map(([key, value]) => [key, String(value)]));
}

/** 构造 `Prompt.Text` 六件套：SDK 构造函数不做运行时校验，可安全用于本地兜底 */
function textPromptData(name: string, template: string, version = 0): TextPromptData {
  return { name, version, labels: [], tags: [], config: {}, type: "text", prompt: template };
}

/**
 * 把模板编译成正文（与线上提示词同一个编译器：`TextPromptClient.compile` / Mustache）。
 *
 * 两点约定：
 *   a. `vars` 未提供或为空对象时原样返回模板 —— 避免空对象把整篇渲染成空；
 *   b. 只对**模板**做变量检测（`findPromptVars`），不对编译结果检测：
 *      转写文本里合法出现的 `{{` 会被误报。
 */
export function compilePrompt(template: string, vars?: PromptVars): string {
  if (!vars || Object.keys(vars).length === 0) return template;
  return new TextPromptClient(textPromptData("inline", template)).compile(toMustacheVars(vars));
}

/** 取模板里出现的所有变量名（去重） */
export function findPromptVars(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(PROMPT_VAR_RE)) {
    found.add(match[1]);
  }
  return [...found];
}

/** 版本号必须为正整数：0 / 浮点 / 字符串都无法在 Langfuse 后端关联到具体版本 */
function assertPromptVersion(name: string, version: unknown): number {
  if (typeof version !== "number" || !Number.isInteger(version) || version <= 0) {
    throw new Error(
      `[prompt] ${name} 的 version 不合法（${JSON.stringify(version)}），必须是正整数；` +
        `请确认已在 Langfuse 保存版本，并把 label "${config.langfusePromptLabel}" 打在该版本上`,
    );
  }
  return version;
}

/** 拒绝 Mustache 控制语法（便宜的一次扫描，避免后台误写导致渲染结构变化/抛错） */
function assertPlainTemplate(name: string, template: string): void {
  if (MUSTACHE_CONTROL_RE.test(template)) {
    throw new Error(
      `[prompt] ${name} 的正文含 Mustache 控制语法（{{#}} / {{^}} / {{>}} / {{=}} / {{{}}}），` +
        `本层只支持 {{变量}} 插值；请在 Langfuse 中改写该提示词`,
    );
  }
}

/** 必需变量校验：远端（strict）缺变量即不可用；本地兜底缺变量只告警（编码错误） */
function checkRequiredVars(
  name: string,
  template: string,
  version: number | null,
  requiredVars: string[] | undefined,
  strict: boolean,
): void {
  if (!requiredVars?.length) return;
  const present = findPromptVars(template);
  const missing = requiredVars.filter((v) => !present.includes(v));
  if (missing.length === 0) return;
  const message =
    `[prompt] 提示词 ${name}${version === null ? "" : ` v${version}`} 缺少必需变量：` +
    `${missing.join(", ")}（应包含：${requiredVars.join(", ")}）`;
  if (strict) {
    throw new Error(message);
  }
  warnOnce(`fallback-missing:${name}:${missing.join(",")}`, `${message}（本地兜底编码错误）`);
}

/** 模板里出现、但调用方这次没提供值的变量（Mustache 会渲染成空串，这里只告警） */
function warnUnprovidedVars(name: string, template: string, vars: PromptVars | undefined): void {
  if (!vars) return;
  const extra = findPromptVars(template).filter((v) => !(v in vars));
  if (extra.length === 0) return;
  warnOnce(
    `extra:${name}:${extra.join(",")}`,
    `[prompt] ${name} 含未提供的变量 ${extra.join(", ")}，将被渲染为空串（检查代码/提示词是否同步）`,
  );
}

/** 懒建 SDK 客户端：没配 key / 被开关关掉时**不构造**，避免 SDK 的缺 key 警告噪音 */
function getClient(): LangfuseClient {
  if (client) return client;
  if (!promptRemoteEnabled()) {
    throw new Error("未配置 LANGFUSE_PUBLIC_KEY/SECRET_KEY，或 LANGFUSE_PROMPTS=0");
  }
  client = new LangfuseClient({
    publicKey: config.langfusePublicKey,
    secretKey: config.langfuseSecretKey,
    baseUrl: config.langfuseBaseUrl,
    // SDK 的 client 级超时单位是秒；单次请求由 fetchTimeoutMs 覆盖
    timeout: PROMPT_FETCH_TIMEOUT_MS / 1000,
  });
  return client;
}

function promptGetOptions(): PromptGetOptions {
  return {
    type: "text",
    label: config.langfusePromptLabel,
    cacheTtlSeconds: toCacheTtlSeconds(config.langfusePromptCacheTtlMs),
    fetchTimeoutMs: PROMPT_FETCH_TIMEOUT_MS,
    // SDK 默认重试 2 次（5s/次）；一次课程会并发多句，宁可快速兜底也不要拖住流水线
    maxRetries: 0,
  };
}

function fetchPrompt(name: string): Promise<TextPromptClient> {
  const options = promptGetOptions();
  if (getterOverride) return getterOverride(name, options);
  return getClient().prompt.get(name, options);
}

/**
 * 单飞 + 负缓存：
 *   - SDK 对「冷启动失败」不写缓存，而 `llmConcurrency` 默认 10，首句批次会同时冷启动；
 *   - 同 key 复用同一个 Promise，失败后 30s 内直接拒绝，不再打 HTTP / 不再刷 SDK 英文 error。
 */
function fetchOnce(name: string): Promise<TextPromptClient> {
  const key = `${name}@${config.langfusePromptLabel}`;
  if ((failedUntil.get(key) ?? 0) > Date.now()) {
    return Promise.reject(new Error("近期拉取失败，负缓存窗口内直接回退"));
  }
  const hit = inflight.get(key);
  if (hit) return hit;

  const pending = fetchPrompt(name)
    .catch((error: unknown) => {
      failedUntil.set(key, Date.now() + NEGATIVE_TTL_MS);
      throw error;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, pending);
  return pending;
}

/** 本地兜底：用同一个编译器渲染本地常量，`version` 映射为 null（0 绝不进 trace 属性） */
function makeFallbackPrompt(
  name: string,
  fallbackText: string,
  opts: GetPromptOptions,
  label: string,
): ManagedPrompt {
  checkRequiredVars(name, fallbackText, null, opts.requiredVars, false);
  warnUnprovidedVars(name, fallbackText, opts.vars);

  let text = fallbackText;
  if (opts.vars && Object.keys(opts.vars).length > 0) {
    try {
      text = new TextPromptClient(textPromptData(name, fallbackText), true).compile(
        toMustacheVars(opts.vars),
      );
    } catch (error) {
      // 本地常量编码错误（未闭合 {{ 等）：fail-open，原样发送模板
      errorOnce(
        `fallback-compile:${name}`,
        `[prompt] 本地兜底 ${name} 编译失败（${
          error instanceof Error ? error.message : String(error)
        }），原样发送模板`,
      );
    }
  }

  return {
    template: fallbackText,
    text,
    name,
    version: null,
    isFallback: true,
    source: "fallback",
    label,
  };
}

export interface GetPromptOptions {
  vars?: PromptVars;
  /** 调用方声明的必需变量；远端模板缺任何一个都视为不可用（回退本地兜底） */
  requiredVars?: string[];
  forceEnabled?: boolean;
}

/**
 * 取一条提示词：SDK 远端优先，失败/未启用时用本地兜底。
 * 永不抛错。
 */
export async function getManagedPrompt(
  name: string,
  fallbackText: string,
  opts: GetPromptOptions = {},
): Promise<ManagedPrompt> {
  const label = config.langfusePromptLabel;
  const enabled = opts.forceEnabled ?? promptRemoteEnabled();
  if (!enabled) return makeFallbackPrompt(name, fallbackText, opts, label);

  try {
    const remote = await fetchOnce(name);

    // 1. 类型：SDK 的 `type` 只用于 TS 重载，运行时按服务端返回的类型实例化；
    //    远端是 chat 时 `prompt` 是消息数组，必须在版本/变量校验前拦住。
    if (typeof remote.prompt !== "string") {
      throw new Error("类型是 chat，当前只支持 Text；请在 Langfuse 中改为 Text 类型");
    }
    const template = remote.prompt;

    // 2. 控制语法：先拦 {{#}}/{{>}}/{{{ 等，否则报错会变成「缺变量」误导排查
    assertPlainTemplate(name, template);

    // 3. 版本：0 / 浮点会让观测关联静默失效
    const version = assertPromptVersion(name, remote.version);

    // 4. 必需变量：迁移期 Langfuse 里还是旧版无变量提示词时，这里回退
    checkRequiredVars(name, template, version, opts.requiredVars, true);
    warnUnprovidedVars(name, template, opts.vars);

    // 5. 编译：未闭合的 {{ 由 Mustache 抛 Unclosed tag，统一走兜底
    const text =
      opts.vars && Object.keys(opts.vars).length > 0
        ? remote.compile(toMustacheVars(opts.vars))
        : template;

    logOnce(
      `ok:${name}:${version}`,
      `[prompt] ${name} source=remote version=${version} label=${label}` +
        ` vars=[${findPromptVars(template).join(",")}]`,
    );

    return {
      template,
      text,
      name,
      version,
      isFallback: false,
      source: "remote",
      label,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // 配置问题（name/label/type/version/变量对不上）需要人工处理，只报一次
    errorOnce(
      `fallback:${name}`,
      `[prompt] 拉取 ${name} 失败（${detail}），改用本地兜底提示词；` +
        `本次 trace 不会关联任何 prompt 版本（Langfuse 观测计数不会增长）`,
    );
    return makeFallbackPrompt(name, fallbackText, opts, label);
  }
}

/**
 * 在「已关联提示词版本」的上下文中执行一次调用。
 *
 * LangfuseSpanProcessor.onStart 会从父上下文读取传播属性，因此这段时间内创建的
 * generation span 会自动带上 prompt name/version，Langfuse 界面即可看到
 * 「这条 trace 用的是哪个版本的提示词」。
 *
 * 三个要点：
 *   1. 先 `ensureTracingStarted()`：legacy 路径上 SDK 是惰性的，首次调用可能早于
 *      `sdk.start()`；那时 `context.with` 走 NoopContextManager，属性会静默丢失；
 *   2. 只有「远端 + 正整数版本」才传 prompt；本地兜底不伪装版本（SDK 也会丢弃 isFallback）；
 *   3. 无论哪种来源都写一份 metadata，让 trace 上能看出本轮用的是远端还是兜底。
 */
export function withPrompt<T>(prompt: ManagedPrompt, fn: () => Promise<T>): Promise<T> {
  ensureTracingStarted();

  const linkable =
    !prompt.isFallback &&
    typeof prompt.version === "number" &&
    Number.isInteger(prompt.version) &&
    prompt.version > 0;

  return propagateAttributes(
    {
      ...(linkable
        ? { prompt: { name: prompt.name, version: prompt.version as number, isFallback: false } }
        : {}),
      metadata: {
        prompt_name: prompt.name,
        prompt_version: prompt.version ?? "none",
        prompt_source: prompt.source,
        prompt_label: prompt.label,
      },
    },
    fn,
  );
}

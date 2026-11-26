/**
 * DashScope（百炼）异步任务的传输层：临时 OSS 上传 + 提交任务 + 轮询 + 下载结果。
 *
 * 为什么需要它：captioner（音频打标）没有同步接口，只能走
 * `POST /api/v1/services/audio/asr/transcription` + `GET /api/v1/tasks/{id}`，
 * 且入参必须是**服务端能取到的文件地址**，本地文件得先上传到百炼的临时 OSS
 * （`getPolicy` 拿凭证 → 表单上传 → `oss://` 地址），提交时带
 * `X-DashScope-OssResourceResolve: enable` 才会被解析。这套流程由
 * `scripts/probe-captioner.ts` 实测验证过（换模型/workspace 时先跑它）。
 *
 * 设计约束：
 *   a. `fetch` / `sleep` / `now` 全部可注入，单测不碰网络、不受真实时间影响；
 *   b. 上传用 `openAsBlob` 而不是 `readFile`：整段长音频的 wav 可能几百 MB，
 *      没必要整个读进内存；
 *   c. 所有错误都带上「是哪一步 + 服务端原文摘要」，因为这类接口的失败原因
 *      （Key 不对、模型没开通、oss:// 不被接受、文件超限）从状态码看不出来。
 */
import { randomUUID } from "node:crypto";
import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";

export interface DashScopeEndpoints {
  /** 带前缀的源站，例如 `https://dashscope.aliyuncs.com` 或 `https://gw.x.com/prefix` */
  origin: string;
  transcriptionUrl: string;
  taskUrl(taskId: string): string;
  uploadPolicyUrl(model: string): string;
}

export interface DashScopeTransportDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
}

/**
 * 从任意形式的 base URL 推导出四个端点。
 *
 * 支持三种写法（`/api/v1/` 之前的部分整体作为前缀保留，兼容私有网关）：
 *   - `https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`
 *   - `https://ws-xxx.cn-beijing.maas.aliyuncs.com`
 *   - `https://gw.example.com/prefix/api/v1/tasks`
 */
export function resolveDashScopeEndpoints(raw: string): DashScopeEndpoints {
  const url = new URL(raw);
  const at = url.pathname.indexOf("/api/v1/");
  const prefix = at >= 0 ? url.pathname.slice(0, at) : "";
  const origin = `${url.origin}${prefix}`.replace(/\/+$/, "");
  return {
    origin,
    transcriptionUrl: `${origin}/api/v1/services/audio/asr/transcription`,
    taskUrl: (taskId) => `${origin}/api/v1/tasks/${encodeURIComponent(taskId)}`,
    uploadPolicyUrl: (model) =>
      `${origin}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(model)}`,
  };
}

function truncate(text: string, n = 500): string {
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

async function readText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** getPolicy 的返回可能在 data / output / 顶层，取第一个能用的 */
interface UploadPolicy {
  policy: string;
  signature: string;
  upload_dir: string;
  upload_host: string;
  oss_access_key_id: string;
  x_oss_object_acl?: string;
  x_oss_forbid_overwrite?: unknown;
  max_file_size_mb?: number;
}

function pickPolicy(json: unknown): Partial<UploadPolicy> {
  const body = json as Record<string, unknown>;
  const candidates = [body?.data, body?.output, body].filter(
    (x): x is Record<string, unknown> => Boolean(x) && typeof x === "object",
  );
  for (const c of candidates) {
    if (c.policy && c.signature && c.upload_dir && c.upload_host && c.oss_access_key_id) {
      return c as unknown as Partial<UploadPolicy>;
    }
  }
  return (candidates[0] ?? {}) as Partial<UploadPolicy>;
}

export interface OssUploadResult {
  /** `oss://<key>`，提交异步任务时作为 file_url */
  ossUrl: string;
  key: string;
  bytes: number;
}

/**
 * 把本地文件传到百炼的临时 OSS，返回 `oss://` 地址。
 * 上传前用 policy 里的 `max_file_size_mb` 预检，避免传完才 400。
 */
export async function uploadToTemporaryOss(
  file: string,
  opts: {
    endpoints: DashScopeEndpoints;
    model: string;
    apiKey: string;
    timeoutMs?: number;
  } & DashScopeTransportDeps,
): Promise<OssUploadResult> {
  const doFetch = opts.fetch ?? fetch;
  const log = opts.log ?? (() => {});
  if (!opts.apiKey) {
    throw new Error("[captioner] 未配置 API Key（FORGE_CAPTIONER_API_KEY 或 FORGE_ASR_API_KEY）");
  }

  const { size } = await stat(file);
  const policyRes = await doFetch(opts.endpoints.uploadPolicyUrl(opts.model), {
    headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  const policyText = await readText(policyRes);
  if (!policyRes.ok) {
    throw new Error(
      `[captioner] 获取上传凭证失败（HTTP ${policyRes.status}）：${truncate(policyText)}`,
    );
  }
  const policy = pickPolicy(JSON.parse(policyText));
  const missing = ["policy", "signature", "upload_dir", "upload_host", "oss_access_key_id"].filter(
    (k) => !(policy as Record<string, unknown>)[k],
  );
  if (missing.length > 0) {
    throw new Error(`[captioner] 上传凭证缺字段 ${missing.join(",")}：${truncate(policyText)}`);
  }

  const maxMb = Number(policy.max_file_size_mb);
  if (Number.isFinite(maxMb) && maxMb > 0 && size > maxMb * 1024 * 1024) {
    throw new Error(
      `[captioner] 音频 ${(size / 1024 / 1024).toFixed(1)}MB 超过临时 OSS 上限 ${maxMb}MB；` +
        `请用切片缩短选区（单段建议 ≤5 分钟）`,
    );
  }

  // 文件名里只保留安全字符：中文/空格/括号在 OSS key 里能用但容易在日志与 URL 里出问题
  const safeName = basename(file).replace(/[^A-Za-z0-9._-]/g, "_");
  const key = `${String(policy.upload_dir).replace(/\/+$/, "")}/${Date.now()}_${randomUUID()}_${safeName}`;
  const form = new FormData();
  form.append("OSSAccessKeyId", String(policy.oss_access_key_id));
  form.append("Signature", String(policy.signature));
  form.append("policy", String(policy.policy));
  if (policy.x_oss_object_acl !== undefined && policy.x_oss_object_acl !== null) {
    form.append("x-oss-object-acl", String(policy.x_oss_object_acl));
  }
  if (policy.x_oss_forbid_overwrite !== undefined && policy.x_oss_forbid_overwrite !== null) {
    form.append("x-oss-forbid-overwrite", String(policy.x_oss_forbid_overwrite));
  }
  form.append("key", key);
  form.append("success_action_status", "200");
  form.append("file", await openAsBlob(file, { type: "audio/wav" }), safeName);

  const upRes = await doFetch(String(policy.upload_host), {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  const upText = await readText(upRes);
  if (!upRes.ok) {
    throw new Error(
      `[captioner] 上传临时 OSS 失败（HTTP ${upRes.status}，${(size / 1024 / 1024).toFixed(1)}MB）：${truncate(upText)}`,
    );
  }
  log(`[captioner] 已上传临时 OSS：${(size / 1024 / 1024).toFixed(2)}MB`);
  return { ossUrl: `oss://${key}`, key, bytes: size };
}

export interface SubmitAsyncOptions {
  endpoints: DashScopeEndpoints;
  model: string;
  apiKey: string;
  fileUrl: string;
  /** captioner 用单值 `file_url`；filetrans 用数组 `file_urls` */
  field?: "file_url" | "file_urls";
  parameters?: Record<string, unknown>;
  timeoutMs?: number;
}

/** 提交异步任务，返回 task_id */
export async function submitAsyncTranscription(
  opts: SubmitAsyncOptions & DashScopeTransportDeps,
): Promise<{ taskId: string; raw: unknown }> {
  const doFetch = opts.fetch ?? fetch;
  if (!opts.apiKey) {
    throw new Error("[captioner] 未配置 API Key（FORGE_CAPTIONER_API_KEY 或 FORGE_ASR_API_KEY）");
  }
  const field = opts.field ?? "file_url";
  const body = {
    model: opts.model,
    input: field === "file_urls" ? { file_urls: [opts.fileUrl] } : { file_url: opts.fileUrl },
    parameters: opts.parameters ?? {},
  };

  const res = await doFetch(opts.endpoints.transcriptionUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
      // 异步任务必需；OssResourceResolve 让服务端解析 oss:// 形式的 file_url
      "X-DashScope-Async": "enable",
      "X-DashScope-OssResourceResolve": "enable",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  const text = await readText(res);
  if (!res.ok) {
    throw new Error(
      `[captioner] 提交标注任务失败（HTTP ${res.status}）：${truncate(text)}\n` +
        `  ├ 模型：${opts.model}\n  └ 文件地址：${opts.fileUrl.slice(0, 160)}`,
    );
  }
  const json = JSON.parse(text) as { output?: { task_id?: string } };
  const taskId = json.output?.task_id;
  if (!taskId) {
    throw new Error(`[captioner] 提交响应缺少 output.task_id：${truncate(text)}`);
  }
  return { taskId, raw: json };
}

const PENDING_STATUSES = new Set(["PENDING", "RUNNING", "SUSPENDED", "UNKNOWN"]);

/** 从查询结果里取结果文件地址：captioner 是扁平字段，filetrans 在 results[] 里 */
export function transcriptionUrlOf(output: unknown): string | undefined {
  const o = output as {
    transcription_url?: string;
    results?: Array<{ transcription_url?: string }>;
    result?: { transcription_url?: string };
  };
  return o?.transcription_url ?? o?.results?.[0]?.transcription_url ?? o?.result?.transcription_url;
}

export interface PollResult {
  status: string;
  transcriptionUrl: string;
  raw: unknown;
}

/** 轮询任务直到 SUCCEEDED；FAILED/CANCELED/超时都抛错 */
export async function pollAsyncTask(
  taskId: string,
  opts: {
    endpoints: DashScopeEndpoints;
    apiKey: string;
    intervalMs: number;
    timeoutMs: number;
    requestTimeoutMs?: number;
    onTick?: (status: string, elapsedMs: number) => void;
  } & DashScopeTransportDeps,
): Promise<PollResult> {
  const doFetch = opts.fetch ?? fetch;
  const doSleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const started = now();

  for (;;) {
    const res = await doFetch(opts.endpoints.taskUrl(taskId), {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      signal: AbortSignal.timeout(opts.requestTimeoutMs ?? 60_000),
    });
    const text = await readText(res);
    if (!res.ok) {
      throw new Error(`[captioner] 查询任务失败（HTTP ${res.status}）：${truncate(text)}`);
    }
    const output = (JSON.parse(text) as { output?: Record<string, unknown> }).output;
    const status = String(output?.task_status ?? "UNKNOWN");
    const elapsed = now() - started;
    opts.onTick?.(status, elapsed);

    if (status === "SUCCEEDED") {
      const subtask = output?.subtask_status;
      if (subtask !== undefined && subtask !== "SUCCEEDED") {
        throw new Error(
          `[captioner] 任务成功但子任务失败（subtask_status=${String(subtask)}）：${truncate(text)}`,
        );
      }
      const url = transcriptionUrlOf(output);
      if (!url) {
        throw new Error(`[captioner] 任务成功但缺少 transcription_url：${truncate(text)}`);
      }
      return { status, transcriptionUrl: url, raw: output };
    }
    if (!PENDING_STATUSES.has(status)) {
      throw new Error(
        `[captioner] 任务未成功（task_status=${status}，task_id=${taskId}）：${truncate(text)}`,
      );
    }
    if (elapsed > opts.timeoutMs) {
      throw new Error(
        `[captioner] 轮询超时（${Math.round(opts.timeoutMs / 1000)}s，最后状态 ${status}，task_id=${taskId}）`,
      );
    }
    await doSleep(opts.intervalMs);
  }
}

/** 下载结果 JSON（transcription_url 有效期 24 小时，下载后立即落盘） */
export async function downloadJson(
  url: string,
  opts?: { timeoutMs?: number } & DashScopeTransportDeps,
): Promise<unknown> {
  const doFetch = opts?.fetch ?? fetch;
  const res = await doFetch(url, { signal: AbortSignal.timeout(opts?.timeoutMs ?? 60_000) });
  const text = await readText(res);
  if (!res.ok) {
    throw new Error(`[captioner] 下载标注结果失败（HTTP ${res.status}）：${truncate(text, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`[captioner] 标注结果不是合法 JSON：${truncate(text, 300)}`);
  }
}

import { spawnSync } from "node:child_process";

import { config } from "./config";

/** nvidia-smi 单卡显存读数（MB） */
export interface VramInfo {
  totalMb: number;
  usedMb: number;
}

/** 解析 `--query-gpu=memory.total,memory.used --format=csv,noheader,nounits` 输出，取第一块 GPU */
export function parseNvidiaSmiMemory(stdout: string): VramInfo | null {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) {
    return null;
  }
  const [total, used] = line.split(",").map((p) => Number(p.trim()));
  if (!Number.isFinite(total) || !Number.isFinite(used)) {
    return null;
  }
  return { totalMb: total, usedMb: used };
}

function readVramViaNvidiaSmi(): VramInfo | null {
  try {
    const result = spawnSync(
      "nvidia-smi",
      ["--query-gpu=memory.total,memory.used", "--format=csv,noheader,nounits"],
      { encoding: "utf-8", timeout: 5000 },
    );
    if (result.status !== 0 || !result.stdout) {
      return null;
    }
    return parseNvidiaSmiMemory(result.stdout);
  } catch {
    // 驱动不在 PATH / 非 NVIDIA 显卡：跳过显存检查
    return null;
  }
}

/** 模型标识补全隐式 :latest，便于 /v1/models 列表比对 */
export function normalizeModelId(id: string): string {
  return id.includes(":") ? id : `${id}:latest`;
}

/**
 * base URL 是否指向本机 LLM 服务（localhost / 127.x / ::1 / *.localhost）。
 * URL 解析失败按云端处理（宁可跳过本地检查，也不要在云端误拦）。
 */
export function isLocalLlmBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "::1" ||
      host === "0.0.0.0" ||
      host.endsWith(".localhost") ||
      host.startsWith("127.")
    );
  } catch {
    return false;
  }
}

/** 服务模型列表中是否包含目标模型 */
export function modelListed(ids: string[], model: string): boolean {
  const want = normalizeModelId(model);
  return ids.some((id) => normalizeModelId(id) === want);
}

/** `ollama list` 的 SIZE 列（二进制单位、GB/MB 混写）-> 模型体积 MB */
export function parseModelListSizeMb(sizeText: string): number | null {
  const m = sizeText.trim().match(/^([\d.]+)\s*(B|[KMTG]i?B)$/i);
  if (!m) {
    return null;
  }
  const value = Number(m[1]);
  if (!Number.isFinite(value)) {
    return null;
  }
  const units: Record<string, number> = {
    B: 1 / 1024 ** 2,
    KB: 1 / 1024,
    MB: 1,
    GB: 1024,
    TB: 1024 * 1024,
    KIB: 1 / 1024,
    MIB: 1,
    GIB: 1024,
    TIB: 1024 * 1024,
  };
  return Math.ceil(value * (units[m[2].toUpperCase()] ?? 1));
}

/** 从 `ollama list` 文本输出中找到目标模型的体积（MB）；未安装/无该模型返回 null */
export function parseOllamaListModelMb(listOutput: string, model: string): number | null {
  const want = normalizeModelId(model);
  for (const line of listOutput.split(/\r?\n/)) {
    const cols = line.trim().split(/\s{2,}/);
    if (cols.length < 3 || normalizeModelId(cols[0]) !== want) {
      continue;
    }
    return parseModelListSizeMb(cols[2]);
  }
  return null;
}

function readModelSizeMbViaCli(): number | null {
  try {
    const result = spawnSync("ollama", ["list"], { encoding: "utf-8", timeout: 15000 });
    if (result.status !== 0 || !result.stdout) {
      return null;
    }
    return parseOllamaListModelMb(result.stdout, config.llmModel);
  } catch {
    // ollama CLI 不在 PATH（远端 LLM 服务等场景）：跳过体积估算
    return null;
  }
}

/** 模型完整进显存所需 MB：权重 + KV cache / CUDA 上下文余量 */
export function estimateRequiredVramMb(modelMb: number, marginMb: number): number {
  return Math.ceil(modelMb) + marginMb;
}

export type VramVerdict =
  | { level: "ok"; freeMb: number; requiredMb: number }
  | { level: "warn"; message: string }
  | { level: "fail"; freeMb: number; requiredMb: number };

/** 显存余量判定（纯函数）。数据不足时只 warn，不拦路 */
export function evaluateVram(input: {
  vram: VramInfo | null;
  modelMb: number | null;
  marginMb: number;
  strict: boolean;
}): VramVerdict {
  const { vram, modelMb, marginMb, strict } = input;
  if (!vram) {
    return {
      level: "warn",
      message: "未检测到 nvidia-smi（AMD/ARM 或驱动不在 PATH），跳过显存检查",
    };
  }
  if (!modelMb) {
    return {
      level: "warn",
      message: "未获取到模型体积（ollama CLI 不可用，或模型列表读取失败），跳过显存检查",
    };
  }
  const freeMb = vram.totalMb - vram.usedMb;
  const requiredMb = estimateRequiredVramMb(modelMb, marginMb);
  if (freeMb >= requiredMb) {
    return { level: "ok", freeMb, requiredMb };
  }
  if (!strict) {
    return {
      level: "warn",
      message:
        `空闲显存 ${freeMb}MB 低于所需约 ${requiredMb}MB，ollama 会把部分层卸载到 CPU，生成会明显变慢` +
        `（可用 FORGE_LLM_VRAM_STRICT=1 改为直接拦停）`,
    };
  }
  return { level: "fail", freeMb, requiredMb };
}

/**
 * LLM 调用前预检：服务可达 -> 模型已安装 -> 显存余量估算。
 * 任何一步异常都快速失败并给出处置办法，避免主流程在注定崩溃的请求上白等。
 */
export async function preflightLlm(): Promise<void> {
  console.log(`[llm] 预检：服务健康 + 模型 + 显存余量...`);
  const base = config.llmBaseUrl.replace(/\/$/, "");

  // 云端端点：ollama 模型列表比对与显存估算必然误报，直接跳过（连通性交给正式请求本身）
  if (!isLocalLlmBaseUrl(config.llmBaseUrl)) {
    console.log(`[llm] 预检：检测到云端端点（${config.llmBaseUrl}），跳过模型列表与显存检查`);
    return;
  }

  const headers: Record<string, string> = config.llmApiKey
    ? { authorization: `Bearer ${config.llmApiKey}` }
    : {};

  // 1. 服务可达并列出模型
  let ids: string[];
  try {
    const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    ids = (json.data ?? []).map((m) => m.id ?? "").filter(Boolean);
  } catch (error) {
    throw new Error(
      `[llm] 预检失败：无法访问 ${base}/models。请确认 LLM 服务在运行` +
        `（Ollama 桌面托盘版会自动拉起服务，无需手动 ollama serve；纯命令行安装才需要 \`ollama serve\`）。` +
        `原始错误: ${(error as Error).message}`,
    );
  }

  // 2. 目标模型存在
  if (!modelListed(ids, config.llmModel)) {
    throw new Error(
      `[llm] 预检失败：服务上没有模型 ${config.llmModel}（现有 ${ids.length} 个：${ids.slice(0, 5).join(", ") || "无"}）。` +
        `请先执行：ollama pull ${config.llmModel}`,
    );
  }

  // 3. 模型体积（ollama list 的 SIZE 列；拿不到则只做健康检查，不拦路）
  const modelMb = readModelSizeMbViaCli();

  // 4. 显存余量
  const verdict = evaluateVram({
    vram: readVramViaNvidiaSmi(),
    modelMb,
    marginMb: config.llmVramMarginMb,
    strict: config.llmVramStrict,
  });
  if (verdict.level === "fail") {
    throw new Error(
      `[llm] 预检失败：显存余量不足（空闲 ${verdict.freeMb}MB < 所需约 ${verdict.requiredMb}MB；${config.llmModel} 权重约 ${modelMb}MB）。` +
        `处置：关闭占显存的应用；` +
        `接受 CPU 卸载慢跑则设 FORGE_LLM_VRAM_STRICT=0 重跑`,
    );
  }
  if (verdict.level === "warn") {
    console.warn(`[llm] 预检提示：${verdict.message}`);
    return;
  }
  console.log(`[llm] 预检通过：空闲显存 ${verdict.freeMb}MB ≥ 所需约 ${verdict.requiredMb}MB`);
}

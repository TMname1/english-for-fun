import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import type { Transcript, TranscriptSegment, TranscriptWord } from "./types";
import { config, repoRoot } from "./config";
import { runFfmpeg } from "./util";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function probeHealth(timeoutMs = 2500): Promise<boolean> {
  for (const path of ["/health", "/v1/models"]) {
    try {
      const res = await fetch(`${config.asrBaseUrl}${path}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        return true;
      }
    } catch {
      // 尝试下一个探测端点
    }
  }
  return false;
}

/**
 * 检查服务端已安装 whisper-1 模型；未安装则 POST /v1/models/whisper-1 触发一次性下载
 * （约 3GB，服务端直接从 HuggingFace 拉取，耗时取决于网络；超时受 FORGE_ASR_WAIT_MS 控制）。
 */
async function ensureModelInstalled(): Promise<void> {
  let ids: string[] | null = null;
  try {
    const res = await fetch(`${config.asrBaseUrl}/v1/models`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const json = (await res.json()) as { data?: Array<{ id?: string }> };
      ids = (json.data ?? []).map((m) => m.id ?? "");
    }
  } catch {
    // 列不出来就无条件触发一次安装（已存在时服务端会快速返回）
  }
  if (ids && ids.some((id) => id === "whisper-1" || id.includes("faster-whisper-large-v3"))) {
    return;
  }

  console.log(`[asr] 服务端尚未安装转写模型，触发下载（约 3GB，首次可能需要几分钟到几十分钟）...`);
  const dl = await fetch(`${config.asrBaseUrl}/v1/models/whisper-1`, {
    method: "POST",
    signal: AbortSignal.timeout(config.asrWaitMs),
  });
  if (!dl.ok) {
    throw new Error(
      `[asr] 模型下载失败（HTTP ${dl.status}）: ${(await dl.text().catch(() => "")).slice(0, 300)}\n` +
        `可手动重试：curl -X POST ${config.asrBaseUrl}/v1/models/whisper-1（需能访问 huggingface.co，必要时给 Docker 配代理）`,
    );
  }
  console.log(`[asr] 模型安装完成`);
}

/**
 * 确保 ASR 服务可用且模型就绪；服务不可用则通过 docker compose（asr profile）拉起并等待健康检查通过。
 * 首次运行会拉镜像并下载模型权重，可能耗时较久（受 FORGE_ASR_WAIT_MS 控制，默认 15 分钟）。
 */
export async function ensureAsrReady(): Promise<void> {
  if (await probeHealth()) {
    await ensureModelInstalled();
    return;
  }

  console.log(`[asr] ASR 服务未就绪，尝试启动容器：docker compose --profile asr up -d asr`);
  const result = spawnSync("docker", ["compose", "--profile", "asr", "up", "-d", "asr"], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || String(result.error ?? "")).trim();
    throw new Error(
      `[asr] docker compose 启动 asr 服务失败。请确认 Docker 已运行、镜像可拉取（必要时配置代理）。\n${detail.slice(0, 800)}`,
    );
  }

  const deadline = Date.now() + config.asrWaitMs;
  let logged = false;
  while (Date.now() < deadline) {
    await sleep(4000);
    if (await probeHealth()) {
      console.log(`[asr] ASR 服务已就绪`);
      await ensureModelInstalled();
      return;
    }
    if (!logged) {
      console.log(
        `[asr] 等待 ASR 服务健康检查（首次启动需拉镜像/下载模型，最长 ${Math.round(config.asrWaitMs / 60000)} 分钟）...`,
      );
      logged = true;
    }
  }
  throw new Error(
    `[asr] 等待超时。可查看日志排查：docker compose logs asr（也可用 FORGE_ASR_WAIT_MS 放宽超时）`,
  );
}

/** 停止 asr 容器的 docker compose 参数（与 ensureAsrReady 的启动参数对称；纯函数便于测试） */
export function asrComposeStopArgs(): string[] {
  return ["compose", "--profile", "asr", "stop", "asr"];
}

/**
 * 转写结束后停掉 asr 容器：whisper 即使空闲也持续驻留显存，小显存卡上会挤爆 LLM 加载。
 * 失败仅告警不阻断——显存问题交给 LLM 预检兜底拦停。
 */
export function stopAsrService(): void {
  const args = asrComposeStopArgs();
  const result = spawnSync("docker", args, { cwd: repoRoot, encoding: "utf-8" });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || String(result.error ?? "")).trim();
    console.warn(
      `[asr] 停止 ASR 容器失败（不影响流程，可手动执行：docker ${args.join(" ")}）：\n${detail.slice(0, 300)}`,
    );
    return;
  }
  console.log(`[asr] 已停止 ASR 容器，显存让给 LLM`);
}

/** 转码为 ASR 友好格式：16kHz 单声道 16-bit PCM wav */
export async function transcodeToWav(audioPath: string, wavPath: string): Promise<void> {
  console.log(`[asr] 转码 16k 单声道 wav -> ${wavPath}`);
  await runFfmpeg([
    "-y",
    "-i",
    audioPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    wavPath,
  ]);
}

interface VerboseSegment {
  id?: number;
  start?: number;
  end?: number;
  text?: string;
  words?: Array<{ word?: string; start?: number; end?: number }>;
}

/** 解析 verbose_json 响应；无词级时间戳时降级为段级 */
export function parseTranscription(json: unknown, language: string): Transcript {
  const raw = (json ?? {}) as { segments?: VerboseSegment[] };
  const segments: TranscriptSegment[] = [];
  let anyWords = false;

  (raw.segments ?? []).forEach((seg, index) => {
    const start = Number(seg.start);
    const end = Number(seg.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return;
    }
    const words: TranscriptWord[] = [];
    for (const w of seg.words ?? []) {
      const ws = Number(w.start);
      const we = Number(w.end);
      const text = (w.word ?? "").trim();
      if (text && Number.isFinite(ws) && Number.isFinite(we)) {
        words.push({ word: text, start: ws, end: we });
      }
    }
    if (words.length > 0) {
      anyWords = true;
    }
    segments.push({
      id: Number.isFinite(Number(seg.id)) ? Number(seg.id) : index,
      start,
      end,
      text: (seg.text ?? "").trim(),
      words: words.length > 0 ? words : undefined,
    });
  });

  if (segments.length === 0) {
    throw new Error("[asr] 转写结果为空，未识别到英文语音（音乐伴奏过密时常见，建议用人声干声）");
  }

  return { wordLevel: anyWords, language, segments };
}

/**
 * 调 ASR 服务转写 wav。优先请求词级时间戳；服务端不支持时自动去掉该参数重试（段级降级）。
 */
export async function transcribe(wavPath: string, language = "en"): Promise<Transcript> {
  const buf = await readFile(wavPath);

  const post = async (withWordTimestamps: boolean) => {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(buf)], { type: "audio/wav" }), "audio.wav");
    form.set("model", "whisper-1");
    form.set("language", language);
    form.set("response_format", "verbose_json");
    if (withWordTimestamps) {
      // 新版 OpenAI 协议参数（speaches 等实现只认这个，不再支持旧的 word_timestamps 布尔值）
      form.set("timestamp_granularities[]", "word");
    }
    return fetch(`${config.asrBaseUrl}/v1/audio/transcriptions`, { method: "POST", body: form });
  };

  console.log(`[asr] 提交转写请求: ${wavPath}`);
  let res = await post(true);
  if (!res.ok) {
    const firstError = await res.text().catch(() => "");
    console.log(
      `[asr] 带 timestamp_granularities[]=word 的请求失败（${res.status}），尝试段级降级重试: ${firstError.slice(0, 200)}`,
    );
    res = await post(false);
  }
  if (!res.ok) {
    throw new Error(
      `[asr] 转写请求失败（HTTP ${res.status}）: ${(await res.text()).slice(0, 400)}`,
    );
  }

  const transcript = parseTranscription(await res.json(), language);
  if (!transcript.wordLevel) {
    console.warn(`[asr] 警告: 服务端未返回词级时间戳，transcript.json 仅含段级文本与起止时间`);
  }
  return transcript;
}

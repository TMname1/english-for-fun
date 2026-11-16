import { readFile } from "node:fs/promises";

import type { ClipRange, Transcript, TranscriptSegment, TranscriptWord } from "./types";
import { config } from "./config";
import { runFfmpeg } from "./util";

/**
 * flash 同步版（qwen-audio-3.1-asr-flash）官方建议单段 ≤5 分钟。超过直接报错，
 * 长音频请用切片把选区分段（流水线已支持多 clip 分段转写 + 合并）。
 */
const MAX_ASR_SECONDS = 300;

/** DashScope Qwen-Audio-ASR 流式返回的词结构（时间戳单位毫秒） */
interface QwenAsrWord {
  text?: string;
  begin_time?: number;
  end_time?: number;
  punctuation?: string;
}

/** DashScope Qwen-Audio-ASR 流式返回的句子结构（时间戳单位毫秒） */
export interface QwenAsrSentence {
  sentence_id?: number;
  begin_time?: number;
  end_time?: number;
  text?: string;
  sentence_end?: boolean;
  words?: QwenAsrWord[];
}

/** 毫秒 → 秒；非法值返回 null */
function msToSeconds(ms: unknown): number | null {
  const n = Number(ms);
  return Number.isFinite(n) ? n / 1000 : null;
}

/** 转码为 ASR 友好格式：16kHz 单声道 16-bit PCM wav；range 存在时只提取该时间区间 */
export async function transcodeToWav(
  audioPath: string,
  wavPath: string,
  range?: ClipRange,
): Promise<void> {
  console.log(
    `[asr] 转码 16k 单声道 wav -> ${wavPath}${range ? `（区间 ${range.start.toFixed(2)}s–${range.end.toFixed(2)}s）` : ""}`,
  );
  // 输入侧 seek + 重编码：对音频是采样级精确的
  const seekArgs = range ? ["-ss", String(range.start), "-t", String(range.end - range.start)] : [];
  await runFfmpeg([
    "-y",
    ...seekArgs,
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

/**
 * 把流式收集到的稳定句子（sentence_end=true）转成 Transcript。
 * 毫秒时间戳换算为秒；词文字 = trim(text) + punctuation，标点并入词尾，与下游 align 的逐词口径一致。
 */
export function buildTranscriptFromSentences(
  sentences: QwenAsrSentence[],
  language: string,
): Transcript {
  const segments: TranscriptSegment[] = [];
  let anyWords = false;

  sentences.forEach((sent, index) => {
    const start = msToSeconds(sent.begin_time);
    const end = msToSeconds(sent.end_time);
    if (start === null || end === null) {
      return;
    }

    const words: TranscriptWord[] = [];
    for (const w of sent.words ?? []) {
      const ws = msToSeconds(w.begin_time);
      const we = msToSeconds(w.end_time);
      const text = `${(w.text ?? "").trim()}${w.punctuation ?? ""}`.trim();
      if (text && ws !== null && we !== null) {
        words.push({ word: text, start: ws, end: we });
      }
    }
    if (words.length > 0) {
      anyWords = true;
    }

    const text = (sent.text ?? "").trim();
    if (!text && words.length === 0) {
      return;
    }

    segments.push({
      // sentence_id 从 1 起，转 0 基与下游 id 口径一致
      id: Number.isFinite(Number(sent.sentence_id)) ? Number(sent.sentence_id) - 1 : index,
      start,
      end,
      text:
        text ||
        words
          .map((x) => x.word)
          .join(" ")
          .trim(),
      words: words.length > 0 ? words : undefined,
    });
  });

  if (segments.length === 0) {
    throw new Error(
      "[asr] 转写结果为空，未识别到语音（伴奏过密或静音时常见，建议用人声干声、或缩短选区）",
    );
  }

  return { wordLevel: anyWords, language, segments };
}

/**
 * 解析 SSE 流，收集每个句子的最终结果（sentence_end=true）。
 * DashScope 流式每个事件带一个 output.sentence，中间事件会反复更新同一句；按 sentence_id 去重取最后一次稳定值。
 */
async function collectFinalSentences(res: Response): Promise<QwenAsrSentence[]> {
  if (!res.body) {
    throw new Error("[asr] 响应没有数据流（SSE body 为空）");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const byId = new Map<number, QwenAsrSentence>();
  let buffer = "";

  const handleEvent = (event: string): void => {
    let payload = "";
    for (const line of event.split("\n")) {
      if (line.startsWith("data:")) {
        payload += line.slice(5).trim();
      }
    }
    if (!payload) return;
    let json: { code?: string; message?: string; output?: { sentence?: QwenAsrSentence } };
    try {
      json = JSON.parse(payload);
    } catch {
      return; // 心跳、[DONE]、状态行等非 JSON 事件忽略
    }
    if (json.code && !json.output) {
      throw new Error(`[asr] 服务返回错误: ${json.code} ${json.message ?? ""}`.trim());
    }
    const sentence = json.output?.sentence;
    if (sentence && sentence.sentence_end === true) {
      const id = Number.isFinite(Number(sentence.sentence_id))
        ? Number(sentence.sentence_id)
        : byId.size + 1;
      byId.set(id, sentence);
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let sep = buffer.indexOf("\n\n");
    while (sep !== -1) {
      handleEvent(buffer.slice(0, sep));
      buffer = buffer.slice(sep + 2);
      sep = buffer.indexOf("\n\n");
    }
  }
  buffer += decoder.decode().replace(/\r\n/g, "\n");
  if (buffer.trim()) {
    handleEvent(buffer);
  }

  return [...byId.values()].sort((a, b) => Number(a.sentence_id ?? 0) - Number(b.sentence_id ?? 0));
}

/**
 * 调百炼 Qwen-Audio-ASR 转写 wav：base64 data URI 上传 + SSE 流式，逐句收集句/词级时间戳。
 * 超 5 分钟直接报错（flash 同步版建议上限）；词级时间戳由模型固定返回。
 */
export async function transcribe(wavPath: string, language = "en"): Promise<Transcript> {
  if (!config.asrApiKey) {
    throw new Error("[asr] 未配置 FORGE_ASR_API_KEY（百炼 DashScope API Key，sk- 开头）");
  }

  const buf = await readFile(wavPath);
  // 16k 单声道 16-bit PCM ≈ 32000 字节/秒（含 44 字节 wav 头），用于入参前的时长校验
  const durationSec = (buf.length - 44) / 32000;
  if (durationSec > MAX_ASR_SECONDS + 1) {
    throw new Error(
      `[asr] 音频约 ${durationSec.toFixed(1)}s，超过单段上限 ${MAX_ASR_SECONDS}s；请用切片把选区缩短到 5 分钟以内`,
    );
  }

  const body = JSON.stringify({
    model: config.asrModel,
    input: {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: { data: `data:audio/wav;base64,${buf.toString("base64")}` },
            },
          ],
        },
      ],
    },
    parameters: {
      format: "wav",
      sample_rate: "16000",
      language_hints: [language],
    },
  });

  console.log(
    `[asr] 提交转写请求: ${wavPath}（${config.asrModel}，约 ${durationSec.toFixed(1)}s）`,
  );
  const res = await fetch(config.asrBaseUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.asrApiKey}`,
      "Content-Type": "application/json",
      "X-DashScope-SSE": "enable",
    },
    body,
    signal: AbortSignal.timeout(config.asrTimeoutMs),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`[asr] 转写请求失败（HTTP ${res.status}）: ${detail.slice(0, 400)}`);
  }

  const transcript = buildTranscriptFromSentences(await collectFinalSentences(res), language);
  if (!transcript.wordLevel) {
    console.warn(`[asr] 警告: 未返回词级时间戳，transcript.json 仅含段级文本与起止时间`);
  }
  return transcript;
}

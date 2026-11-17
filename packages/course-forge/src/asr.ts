import { readFile } from "node:fs/promises";

import type { ClipRange, Transcript, TranscriptSegment, TranscriptWord } from "./types";
import { config } from "./config";
import { runFfmpeg } from "./util";

/**
 * flash 同步版（qwen-audio-3.1-asr-flash）官方建议单段 ≤5 分钟。超过直接报错，
 * 长音频请用切片把选区分段（流水线已支持多 clip 分段转写 + 合并）。
 */
const MAX_ASR_SECONDS = 300;

/** DashScope Qwen-Audio-ASR 同步返回的词结构（时间戳单位毫秒） */
export interface QwenAsrWord {
  text?: string;
  begin_time?: number;
  end_time?: number;
  punctuation?: string;
}

/** DashScope Qwen-Audio-ASR 同步返回的句子结构（时间戳单位毫秒） */
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

/** 有效 ASR 词 + 碎片拼接信息（供预处理确定性合并碎片词） */
export interface AsrWordInfo {
  word: TranscriptWord;
  /**
   * 可否无空格拼到前一个有效词：原始文本无前导空格，且原始序列里紧邻前一个有效词。
   * ASR 把词拦腰拆开时碎片无空格（"Genu"+"inely"）；正常词带前导空格（" and"）；
   * 独立词（"I"/"a"）虽可能无空格，但其前面的纯空格占位 token 已被过滤、打破相邻关系。
   */
  attachToPrev: boolean;
}

/** 单个 ASR 句子的有效部分；缺时间戳或无内容时返回 null（应丢弃） */
export interface AsrSegmentParts {
  start: number;
  end: number;
  text: string;
  words: AsrWordInfo[];
}

/**
 * 按统一口径提取句子有效部分：毫秒换算为秒；词文字 = trim(text) + punctuation，
 * 标点并入词尾，与下游 align 的逐词口径一致。buildTranscriptFromSentences 与预处理共用。
 */
export function asrSegmentParts(sent: QwenAsrSentence): AsrSegmentParts | null {
  const start = msToSeconds(sent.begin_time);
  const end = msToSeconds(sent.end_time);
  if (start === null || end === null) {
    return null;
  }

  const words: AsrWordInfo[] = [];
  let lastValidRaw = -2;
  (sent.words ?? []).forEach((w, j) => {
    const ws = msToSeconds(w.begin_time);
    const we = msToSeconds(w.end_time);
    const text = `${(w.text ?? "").trim()}${w.punctuation ?? ""}`.trim();
    if (!text || ws === null || we === null) {
      return;
    }
    const attachToPrev = j === lastValidRaw + 1 && !/^\s/.test(w.text ?? "");
    words.push({ word: { word: text, start: ws, end: we }, attachToPrev });
    lastValidRaw = j;
  });

  const text = (sent.text ?? "").trim();
  if (!text && words.length === 0) {
    return null;
  }

  return {
    start,
    end,
    text:
      text ||
      words
        .map((x) => x.word.word)
        .join(" ")
        .trim(),
    words,
  };
}

/**
 * 把 ASR 句子转成 Transcript。
 * 毫秒时间戳换算为秒；词文字 = trim(text) + punctuation，标点并入词尾，与下游 align 的逐词口径一致。
 */
export function buildTranscriptFromSentences(
  sentences: QwenAsrSentence[],
  language: string,
): Transcript {
  const segments: TranscriptSegment[] = [];
  let anyWords = false;

  for (const sent of sentences) {
    const parts = asrSegmentParts(sent);
    if (!parts) {
      continue;
    }
    if (parts.words.length > 0) {
      anyWords = true;
    }
    segments.push({
      id: segments.length,
      start: parts.start,
      end: parts.end,
      text: parts.text,
      words: parts.words.length > 0 ? parts.words.map((x) => x.word) : undefined,
    });
  }

  if (segments.length === 0) {
    throw new Error(
      "[asr] 转写结果为空，未识别到语音（伴奏过密或静音时常见，建议用人声干声、或缩短选区）",
    );
  }

  return { wordLevel: anyWords, language, segments };
}

/**
 * 解析同步响应 JSON：output.sentence 为单个句子对象（整段 text + 全部词）。
 * 防御性兼容数组写法；错误载荷（code 且无 output）抛错。
 */
export function parseSyncSentence(json: unknown): QwenAsrSentence[] {
  const body = json as {
    code?: string;
    message?: string;
    output?: { sentence?: QwenAsrSentence | QwenAsrSentence[] };
  };
  if (body?.code && !body.output) {
    throw new Error(`[asr] 服务返回错误: ${body.code} ${body.message ?? ""}`.trim());
  }
  const sentence = body?.output?.sentence;
  if (!sentence) {
    throw new Error(`[asr] 同步响应缺少 output.sentence: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return Array.isArray(sentence) ? sentence : [sentence];
}

/**
 * 调百炼 Qwen-Audio-ASR 转写 wav：base64 data URI 上传 + 同步调用，等待完整结果一次返回
 * （output.sentence 单句对象，含整段 text 与全部词级毫秒时间戳）。
 * 超 5 分钟直接报错（flash 同步版建议上限）。同时返回原始句子供预处理合并碎片词。
 */
export async function transcribeWithRaw(
  wavPath: string,
  language = "en",
): Promise<{ transcript: Transcript; sentences: QwenAsrSentence[] }> {
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
    `[asr] 提交转写请求: ${wavPath}（${config.asrModel}，约 ${durationSec.toFixed(1)}s，同步等待完整结果）`,
  );
  const res = await fetch(config.asrBaseUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.asrApiKey}`,
      "Content-Type": "application/json",
    },
    body,
    signal: AbortSignal.timeout(config.asrTimeoutMs),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`[asr] 转写请求失败（HTTP ${res.status}）: ${detail.slice(0, 400)}`);
  }

  const sentences = parseSyncSentence(await res.json());
  const transcript = buildTranscriptFromSentences(sentences, language);
  if (!transcript.wordLevel) {
    console.warn(`[asr] 警告: 未返回词级时间戳，transcript.json 仅含段级文本与起止时间`);
  }
  return { transcript, sentences };
}

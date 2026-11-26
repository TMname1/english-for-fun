import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { HumanMessage } from "@langchain/core/messages";

import type { QwenAsrSentence } from "./asr-model";
import type { ClipRange, Transcript, TranscriptSegment, TranscriptWord } from "./types";
import { asrSentencesOf, buildAsrModel } from "./asr-model";
import { config } from "./config";
import { runFfmpeg } from "./util";

/** 协议层（请求/响应形状）在 asr-model.ts；这里再导出，保持既有 import 路径不变 */
export { parseSyncSentence } from "./asr-model";
export type { QwenAsrSentence, QwenAsrWord } from "./asr-model";

/**
 * flash 同步版（qwen-audio-3.1-asr-flash）官方建议单段 ≤5 分钟。超过直接报错，
 * 长音频请用切片把选区分段（流水线已支持多 clip 分段转写 + 合并）。
 */
const MAX_ASR_SECONDS = 300;

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
  try {
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
  } catch (error) {
    // 扩展名在白名单里仍可能失败：文件损坏 / 内容与扩展名不符（把 .md 改名成 .mp4）/ 容器里没有音轨
    throw new Error(
      `[asr] 无法从这个文件提取音频：${audioPath}\n` +
        `  ├ 常见原因：文件损坏；扩展名与实际内容不符（例如文本文件改名成 .mp4）；容器内没有音轨\n` +
        `  └ 原始错误：${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
 * 构造 ASR 观测的「人类可读入参」。
 *
 * 为什么不是直接把音频塞进消息：messages 会被 callback 层序列化进 trace，57s 的 wav
 * base64 就有 1~2MB、5 分钟能到 13MB，会把 Langfuse 整批上报撑挂。所以这里只放摘要，
 * 结构化字段另外走 `metadata`，音频本体只随请求体发送、不进追踪。
 */
export function asrInputSummary(input: {
  wavName: string;
  durationSec: number;
  audioBytes: number;
  language: string;
}): string {
  const mb = (input.audioBytes / 1024 / 1024).toFixed(2);
  return [
    "转写音频（DashScope Qwen-Audio-ASR，同步返回句/词级毫秒时间戳）",
    `- 文件：${input.wavName}（wav / 16 kHz / 单声道 / 16-bit PCM）`,
    `- 时长：${input.durationSec.toFixed(1)}s（单段上限 ${MAX_ASR_SECONDS}s）`,
    `- 音频数据：base64 内联约 ${mb} MB（体积过大，不写入追踪输入）`,
    `- 语言提示：${input.language}`,
  ].join("\n");
}

/**
 * 调百炼 Qwen-Audio-ASR 转写 wav，返回**原始句子**（毫秒时间戳，未经换算）。
 *
 * 与 `transcribeWithRaw` 的区别：这里允许「空结果」（返回空数组），因为转写子图按
 * 块调用，单块静音是正常情况，是否算失败由上层（全部块都为空）决定。
 * 超 5 分钟直接报错（flash 同步版建议上限）。
 */
export async function transcribeSentences(
  wavPath: string,
  language = "en",
): Promise<{ sentences: QwenAsrSentence[]; durationSec: number; audioBytes: number }> {
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

  console.log(
    `[asr] 提交转写请求: ${wavPath}（${config.asrModel}，约 ${durationSec.toFixed(1)}s，同步等待完整结果）`,
  );

  // 音频走构造参数（不进 messages）：messages 会被 callback 层序列化进 trace，
  // 5 分钟 wav 的 base64 约 13MB，直接放进消息会把 Langfuse 上报撑挂。
  const model = buildAsrModel({
    audio: `data:audio/wav;base64,${buf.toString("base64")}`,
    language,
    durationSec,
  });
  const message = await model
    .withConfig({
      runName: "asr",
      // 结构化字段走 metadata：Langfuse 会把它们并到这条观测上，便于按模型/时长筛选
      metadata: {
        asr: {
          model: config.asrModel,
          format: "wav",
          sample_rate: 16000,
          channels: 1,
          bit_depth: 16,
          duration_sec: Number(durationSec.toFixed(2)),
          audio_bytes: buf.length,
          language,
          wav_path: wavPath,
        },
      },
    })
    .invoke([
      new HumanMessage(
        asrInputSummary({
          wavName: basename(wavPath),
          durationSec,
          audioBytes: buf.length,
          language,
        }),
      ),
    ]);

  return { sentences: asrSentencesOf(message), durationSec, audioBytes: buf.length };
}

/**
 * 调百炼 Qwen-Audio-ASR 转写 wav：经 `asr-model.ts` 的 ChatModel（LangChain Runnable）
 * 完成「base64 data URI 上传 + 同步等待完整结果」。因此这一步与 LLM 调用同属一个生态：
 * 图内自动继承根 callbacks，legacy 由模型构造器兜底挂 handler，Langfuse 里是一条独立的
 * LLM 观测（观测名 = `asr`，model = qwen-audio-3.1-asr-flash）。
 *
 * 返回原始句子（毫秒时间戳，未经换算）供预处理合并碎片词；空结果抛错（legacy 语义：
 * 整段都没有语音属于失败）。转写子图按块调用时用 `transcribeSentences`，允许空块。
 */
export async function transcribeWithRaw(
  wavPath: string,
  language = "en",
): Promise<{ transcript: Transcript; sentences: QwenAsrSentence[] }> {
  const { sentences } = await transcribeSentences(wavPath, language);
  const transcript = buildTranscriptFromSentences(sentences, language);
  if (!transcript.wordLevel) {
    console.warn(`[asr] 警告: 未返回词级时间戳，transcript.json 仅含段级文本与起止时间`);
  }
  return { transcript, sentences };
}

/**
 * transcribe 子图的磁盘/网络实现：三个节点各一个方法，只读写既有产物，不感知 LangGraph。
 *
 * 流程（每个 unit = 一个 clip 或整段）：
 *   1. `asrSentence`    转码 unit wav → 上传临时 OSS → captioner 异步任务 → 句级时间戳 → caption.json
 *                       （这段模型调用封在 `captioner-model.ts`，Langfuse 里是一条 `caption` generation）
 *   2. `processingAudio` 句级时间戳装块（≤180s）→ ffmpeg 切块 → chunk-plan.json
 *   3. `asrWord`         逐块 asr-flash（并发）→ 中点去重 + 跨块碎片修复 → 每块一条 ASR 句子
 *                       → buildTranscriptFromSentences + preprocessTranscript → transcript.json
 *
 * 产物与 legacy `forge.ts: transcribeRun()` **同构**：`transcript.json` /
 * `transcript.raw.json` / `clips.json` 结构不变，下游 structureBatch / align 无需感知。
 */
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

import type { QwenAsrSentence, QwenAsrWord } from "../asr-model";
import type { CaptionMediaResult } from "../captioner";
import type { ChunkSpec, SpanMs } from "../chunk-plan";
import type { ClipRange, Transcript } from "../types";
import type { StageEmitter } from "./events";
import type { TranscriptStateType, TranscriptStateUpdate } from "./transcribe-state";
import { buildTranscriptFromSentences, transcodeToWav, transcribeSentences } from "../asr";
import { captionMedia } from "../captioner";
import { planChunks, repairChunkBoundaries, selectWordsInCore } from "../chunk-plan";
import { mergeClipTranscripts } from "../clips";
import { config } from "../config";
import { paths, readJson, writeJson } from "../forge";
import { mapWithConcurrency } from "../llm";
import { preprocessTranscript } from "../preprocess";

/** caption.json 里一个 unit 的记录（时间统一为绝对毫秒，便于人工核对切块） */
export interface CaptionUnitRecord {
  unitIndex: number;
  clipIndex: number;
  /** clip 起点（毫秒）；无切片为 0 */
  baseMs: number;
  taskId: string;
  model: string;
  source: CaptionMediaResult["source"];
  channelDurationMs?: number;
  /** captioner 的语音段，已加 baseMs 变成绝对毫秒 */
  spans: SpanMs[];
  /** 该 unit 的转码产物（切块的输入） */
  wav: string;
}

export interface CaptionFile {
  version: 1;
  model: string;
  units: CaptionUnitRecord[];
}

export interface ChunkRecord extends ChunkSpec {
  wav: string;
}

export interface ChunkPlanFile {
  version: 1;
  maxMs: number;
  padMs: number;
  chunks: ChunkRecord[];
}

/** 便于单测注入假实现（不碰 ffmpeg / 网络 / LLM） */
export interface TranscribeIO {
  caption: typeof captionMedia;
  transcribe: typeof transcribeSentences;
  transcode: typeof transcodeToWav;
  preprocess: typeof preprocessTranscript;
}

const defaultIO: TranscribeIO = {
  caption: captionMedia,
  transcribe: transcribeSentences,
  transcode: transcodeToWav,
  preprocess: preprocessTranscript,
};

export interface TranscribeArtifactSource {
  asrSentence(state: TranscriptStateType): Promise<TranscriptStateUpdate>;
  processingAudio(state: TranscriptStateType): Promise<TranscriptStateUpdate>;
  asrWord(state: TranscriptStateType): Promise<TranscriptStateUpdate>;
}

interface UnitPlan {
  unitIndex: number;
  clipIndex: number;
  clip?: ClipRange;
}

/** 秒 → 千分位秒字符串再转数字，避免 179.99999999 这类浮点边界传给 ffmpeg */
function toSeconds(ms: number): number {
  return Number((ms / 1000).toFixed(3));
}

export class TranscribeArtifacts implements TranscribeArtifactSource {
  private readonly io: TranscribeIO;

  constructor(
    private readonly emitStage: StageEmitter,
    io?: Partial<TranscribeIO>,
    private readonly log: (message: string) => void = (m) => console.log(m),
  ) {
    this.io = { ...defaultIO, ...io };
  }

  /** 节点 1：captioner 拿句级时间戳（每个 unit 一次异步任务，顺序执行避免争配额） */
  async asrSentence(state: TranscriptStateType): Promise<TranscriptStateUpdate> {
    const { mediaPath, clips } = state.params;
    if (!mediaPath) {
      throw new Error("[transcribe] state 缺少 mediaPath，无法开始转写");
    }
    if (!state.outDir) {
      throw new Error("[transcribe] state 缺少 outDir，无法写转写产物");
    }

    const units: UnitPlan[] = clips?.length
      ? clips.map((clip, i) => ({ unitIndex: i, clipIndex: i, clip }))
      : [{ unitIndex: 0, clipIndex: 0, clip: undefined }];

    const workDir = paths.work(state.outDir);
    await mkdir(resolve(workDir, "units"), { recursive: true });
    this.emitStage("transcoding");

    const records: CaptionUnitRecord[] = [];
    for (const unit of units) {
      const label = unit.clip
        ? `clip ${unit.unitIndex + 1}/${units.length}（${unit.clip.start.toFixed(2)}s–${unit.clip.end.toFixed(2)}s）`
        : "整段";
      this.log(`[transcribe] ${label}：转码并提交 captioner…`);
      const result = await this.io.caption({
        mediaPath,
        clip: unit.clip,
        unitIndex: unit.unitIndex,
        workDir,
      });
      this.emitStage("transcribing");

      records.push({
        unitIndex: unit.unitIndex,
        clipIndex: unit.clipIndex,
        baseMs: result.baseMs,
        taskId: result.taskId,
        model: result.model,
        source: result.source,
        channelDurationMs: result.channelDurationMs,
        // captioner 的时间相对 unit wav，加 baseMs 变成绝对时间
        spans: result.spans.map((s) => ({
          start: s.beginMs + result.baseMs,
          end: s.endMs + result.baseMs,
        })),
        wav: result.wavPath,
      });
      this.log(`[transcribe] ${label}：${result.spans.length} 段语音（source=${result.source}）`);
    }

    const file: CaptionFile = {
      version: 1,
      model: records[0]?.model ?? config.captionerModel,
      units: records,
    };
    await writeJson(paths.caption(state.outDir), file);
    return { unitCount: units.length };
  }

  /** 节点 2：按句边界装块并切音频（纯规划 + ffmpeg） */
  async processingAudio(state: TranscriptStateType): Promise<TranscriptStateUpdate> {
    const caption = await readJson<CaptionFile>(paths.caption(state.outDir));
    const maxMs = Math.max(1, Math.round(config.asrChunkSeconds * 1000));
    const padMs = Math.max(0, config.asrChunkPadMs);
    const chunksDir = resolve(paths.work(state.outDir), "chunks");
    await mkdir(chunksDir, { recursive: true });

    const chunks: ChunkRecord[] = [];
    for (const unit of caption.units) {
      const specs = planChunks({
        unitIndex: unit.unitIndex,
        clipIndex: unit.clipIndex,
        clip: state.params.clips?.[unit.clipIndex],
        spans: unit.spans,
        maxMs,
        padMs,
        unitDurationMs: unit.channelDurationMs,
      });
      for (const spec of specs) {
        const wav = resolve(chunksDir, `u${unit.unitIndex}-c${spec.index}.wav`);
        await this.io.transcode(unit.wav, wav, {
          start: toSeconds(spec.local.start),
          end: toSeconds(spec.local.end),
        });
        chunks.push({ ...spec, wav });
      }
      this.log(
        `[transcribe] unit ${unit.unitIndex}：切出 ${specs.length} 块（上限 ${maxMs / 1000}s）`,
      );
    }

    if (chunks.length === 0) {
      throw new Error("[transcribe] 没有任何可转写的音频块（captioner 未给出有效语音段）");
    }

    const plan: ChunkPlanFile = { version: 1, maxMs, padMs, chunks };
    await writeJson(paths.chunkPlan(state.outDir), plan);
    return { chunkCount: chunks.length };
  }

  /** 节点 3：逐块 asr-flash 拿词级时间戳，组装 transcript 并清理 .work */
  async asrWord(state: TranscriptStateType): Promise<TranscriptStateUpdate> {
    const plan = await readJson<ChunkPlanFile>(paths.chunkPlan(state.outDir));
    const language = state.params.language;

    const perChunk = await mapWithConcurrency(
      plan.chunks,
      Math.max(1, config.asrConcurrency),
      async (chunk, index) => {
        this.log(
          `[asr-chunk] 块 ${index + 1}/${plan.chunks.length}（${(chunk.audio.start / 1000).toFixed(2)}–${(chunk.audio.end / 1000).toFixed(2)}s）提交 asr-flash…`,
        );
        const { sentences } = await this.io.transcribe(chunk.wav, language);
        const words: QwenAsrWord[] = sentences.flatMap((s) => s.words ?? []);
        // keep 而不是 core：首/末块要吃到 padding 里的词，否则开头会丢词（实测丢过 "One more"）
        const { kept, dropped } = selectWordsInCore(words, chunk.keep, chunk.audio.start);

        if (kept.length === 0) {
          // 块内静音，或模型只给了段级文本（无词时间戳）
          const text = sentences
            .map((s) => (s.text ?? "").trim())
            .filter(Boolean)
            .join(" ");
          this.log(
            `[asr-chunk] 块 ${index + 1}/${plan.chunks.length}：无有效词（${text ? "段级降级" : "静音"}）`,
          );
          return {
            chunk,
            dropped,
            sentence: text
              ? ({
                  sentence_id: chunk.index,
                  begin_time: chunk.core.start,
                  end_time: chunk.core.end,
                  text,
                } satisfies QwenAsrSentence)
              : null,
          };
        }

        this.log(
          `[asr-chunk] 块 ${index + 1}/${plan.chunks.length}：${kept.length} 词（边界丢弃 ${dropped}）`,
        );
        return {
          chunk,
          dropped,
          sentence: {
            sentence_id: chunk.index,
            begin_time: kept[0].beginMs,
            end_time: kept[kept.length - 1].endMs,
            // 词的原样文本与标点必须保留（含前导空格）：preprocess 靠它判断碎片是否 attachToPrev
            text: kept
              .map((k) => `${k.raw.text ?? ""}${k.raw.punctuation ?? ""}`)
              .join("")
              .trim(),
            words: kept.map((k) => ({
              text: k.raw.text,
              punctuation: k.raw.punctuation,
              begin_time: k.beginMs,
              end_time: k.endMs,
            })),
          } satisfies QwenAsrSentence,
        };
      },
    );

    // 按 unit 分组（保持 unit 顺序），组内按块起点排序后修复跨块碎片
    const caption = await readJson<CaptionFile>(paths.caption(state.outDir));
    const parts: Transcript[] = [];
    const rawParts: Transcript[] = [];
    let droppedWords = 0;

    for (const unit of caption.units) {
      const group = perChunk
        .filter((item) => item.chunk.unitIndex === unit.unitIndex)
        .sort((a, b) => a.chunk.core.start - b.chunk.core.start);
      droppedWords += group.reduce((n, item) => n + item.dropped, 0);

      const rawSentences: QwenAsrSentence[] = group
        .map((item): QwenAsrSentence | null => item.sentence)
        .filter((s): s is QwenAsrSentence => s !== null);
      const repaired = repairChunkBoundaries(rawSentences).sentences;

      if (repaired.length === 0) {
        // 空 unit 也必须占位：mergeClipTranscripts 用数组下标当 clipIndex
        const empty: Transcript = { wordLevel: false, language, segments: [] };
        rawParts.push(empty);
        parts.push(empty);
        this.log(`[transcribe] unit ${unit.unitIndex}：未识别到语音，已占位`);
        continue;
      }

      const raw = buildTranscriptFromSentences(repaired, language);
      const preprocessed = raw.wordLevel ? await this.io.preprocess(raw, repaired) : raw;
      rawParts.push(raw);
      parts.push(preprocessed);
    }

    if (parts.every((p) => p.segments.length === 0)) {
      throw new Error("[transcribe] 全部分块转写为空，未识别到语音（静音 / 纯音乐？）");
    }

    // 无切片时不做 merge：保持与 legacy 完全一致的产物（不带 clipIndex）
    const transcript = state.params.clips?.length ? mergeClipTranscripts(parts) : parts[0];
    const rawTranscript = state.params.clips?.length ? mergeClipTranscripts(rawParts) : rawParts[0];

    await writeJson(paths.transcript(state.outDir), transcript);
    await writeJson(paths.transcriptRaw(state.outDir), rawTranscript);
    if (state.params.clips?.length) {
      await writeJson(paths.clips(state.outDir), state.params.clips);
    }

    if (config.keepWork) {
      this.log(`[transcribe] FORGE_KEEP_WORK=1，保留工作目录：${paths.work(state.outDir)}`);
    } else {
      // 与 legacy 一致：成功即清理；失败时保留（异常已在上面抛出，不会走到这里）
      await rm(paths.work(state.outDir), { recursive: true, force: true });
    }

    this.log(
      `[forge] 转写 + 预处理完成：${transcript.segments.length} 个完整句（词级时间戳：${transcript.wordLevel ? "有" : "无，段级降级"}）`,
    );
    return {
      chunkDone: plan.chunks.length,
      segmentCount: transcript.segments.length,
      wordLevel: transcript.wordLevel,
      droppedWords,
    };
  }
}

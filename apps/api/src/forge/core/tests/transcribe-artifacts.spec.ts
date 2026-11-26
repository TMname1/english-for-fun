import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { TranscribeIO } from "../graph/transcribe-artifacts";
import type { TranscriptStateType } from "../graph/transcribe-state";
import type { ClipRange, Transcript } from "../types";
import { paths, readJson } from "../forge";
import { TranscribeArtifacts } from "../graph/transcribe-artifacts";

/** 每个 unit 的 captioner 输出（相对 unit wav 的毫秒段） */
type CaptionStub = Record<number, Array<{ beginMs: number; endMs: number }>>;
type DurationStub = Record<number, number>;

function makeIO(
  captionSpans: CaptionStub,
  durations: DurationStub,
  opts?: {
    failOnChunk?: string;
  },
): Partial<TranscribeIO> {
  return {
    caption: (async (args: { unitIndex: number; clip?: ClipRange; workDir: string }) => {
      const spans = captionSpans[args.unitIndex] ?? [];
      return {
        spans,
        source: "speech_segments" as const,
        channelDurationMs: durations[args.unitIndex] ?? 0,
        unitIndex: args.unitIndex,
        baseMs: args.clip ? Math.round(args.clip.start * 1000) : 0,
        taskId: `task-${args.unitIndex}`,
        model: "stub-captioner",
        wavPath: resolve(
          args.workDir,
          "units",
          args.clip ? `unit-${args.unitIndex}.wav` : "unit-full.wav",
        ),
      };
    }) as unknown as TranscribeIO["caption"],

    // 把块的 local 区间写进"wav"，供下面的 transcribe 桩按区间造词
    transcode: (async (_input: string, output: string, range?: ClipRange) => {
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, JSON.stringify(range ?? { start: 0, end: 0 }), "utf-8");
    }) as unknown as TranscribeIO["transcode"],

    // 每秒一个词，时间相对块音频起点（0 基）
    transcribe: (async (wav: string) => {
      if (opts?.failOnChunk && wav.includes(opts.failOnChunk)) {
        throw new Error(`[stub] 块转写失败: ${wav}`);
      }
      const range = JSON.parse(await readFile(wav, "utf-8")) as ClipRange;
      const durationSec = Math.max(0, range.end - range.start);
      const words = Array.from({ length: Math.floor(durationSec) }, (_, t) => ({
        text: t === 0 ? "w0" : ` w${t}`,
        begin_time: t * 1000,
        end_time: (t + 1) * 1000,
      }));
      return {
        sentences: [
          {
            begin_time: 0,
            end_time: Math.round(durationSec * 1000),
            text: words.map((w) => w.text.trim()).join(" "),
            words,
          },
        ],
        durationSec,
        audioBytes: 0,
      };
    }) as unknown as TranscribeIO["transcribe"],

    preprocess: (async (transcript: Transcript) =>
      transcript) as unknown as TranscribeIO["preprocess"],
  };
}

function stateOf(outDir: string, clips?: ClipRange[]): TranscriptStateType {
  return {
    outDir,
    params: { mediaPath: "D:/media/demo.mp4", language: "en", clips },
  } as unknown as TranscriptStateType;
}

async function runTranscribe(outDir: string, clips?: ClipRange[]) {
  const state = stateOf(outDir, clips);
  const io = makeIO(
    // 每个 unit 都是 0 起的一段语音
    { 0: [{ beginMs: 0, endMs: 5_000 }] },
    { 0: 6_000 },
  );
  const artifacts = new TranscribeArtifacts(
    () => {},
    io,
    () => {},
  );
  await artifacts.asrSentence(state);
  await artifacts.processingAudio(state);
  return { artifacts, state };
}

describe("TranscribeArtifacts", () => {
  let outDir = "";

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "transcribe-"));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it("单 unit：caption → 切块 → 词级 transcript，产物结构与 legacy 同构", async () => {
    const { artifacts, state } = await runTranscribe(outDir);
    const update = await artifacts.asrWord(state);

    const transcript = await readJson<Transcript>(paths.transcript(outDir));
    const raw = await readJson<Transcript>(paths.transcriptRaw(outDir));

    expect(transcript.wordLevel).toBe(true);
    expect(transcript.segments.length).toBeGreaterThan(0);
    expect(transcript.segments[0].words?.length).toBeGreaterThan(0);
    // 无切片时不应出现 clipIndex（与 legacy 单段产物一致）
    expect(transcript.segments[0].clipIndex).toBeUndefined();
    expect(raw.wordLevel).toBe(true);
    expect(update.segmentCount).toBe(transcript.segments.length);
    expect(update.wordLevel).toBe(true);
  });

  it("两个 clip：跨块边界的词只出现一次，clipIndex 正确", async () => {
    const clips: ClipRange[] = [
      { start: 0, end: 180 },
      { start: 180, end: 200 },
    ];
    const state = stateOf(outDir, clips);
    const io = makeIO(
      {
        0: [{ beginMs: 0, endMs: 180_000 }],
        1: [{ beginMs: 0, endMs: 20_000 }],
      },
      { 0: 180_000, 1: 20_000 },
    );
    const artifacts = new TranscribeArtifacts(
      () => {},
      io,
      () => {},
    );
    await artifacts.asrSentence(state);
    const planUpdate = await artifacts.processingAudio(state);
    expect(planUpdate.chunkCount).toBe(2);
    await artifacts.asrWord(state);

    const transcript = await readJson<Transcript>(paths.transcript(outDir));
    const words = transcript.segments.flatMap((s) => s.words ?? []);

    // 200 秒、每秒一个词：既没有重复（padding 重叠区按中点归属），也没有丢
    expect(words).toHaveLength(200);
    const starts = words.map((w) => w.start);
    expect(new Set(starts).size).toBe(200);
    for (let i = 1; i < starts.length; i += 1) expect(starts[i]).toBeGreaterThan(starts[i - 1]);

    expect(transcript.segments.map((s) => s.clipIndex)).toEqual([0, 1]);
  });

  it("某个 clip 全静音时占位，不破坏后续 clip 的 clipIndex", async () => {
    const clips: ClipRange[] = [
      { start: 0, end: 10 },
      { start: 10, end: 20 },
    ];
    const state = stateOf(outDir, clips);
    const io = makeIO({ 0: [{ beginMs: 0, endMs: 5_000 }], 1: [] }, { 0: 6_000, 1: 0 });
    const artifacts = new TranscribeArtifacts(
      () => {},
      io,
      () => {},
    );
    await artifacts.asrSentence(state);
    await artifacts.processingAudio(state);
    await artifacts.asrWord(state);

    const transcript = await readJson<Transcript>(paths.transcript(outDir));
    expect(transcript.segments.length).toBeGreaterThan(0);
    expect(transcript.segments.every((s) => s.clipIndex === 0)).toBe(true);
  });

  it("全部块转写为空时整体报错", async () => {
    const state = stateOf(outDir);
    const io = makeIO({ 0: [{ beginMs: 0, endMs: 5_000 }] }, { 0: 6_000 });
    // 让 transcribe 返回空句子
    io.transcribe = (async () => ({
      sentences: [],
      durationSec: 5,
      audioBytes: 0,
    })) as unknown as TranscribeIO["transcribe"];

    const artifacts = new TranscribeArtifacts(
      () => {},
      io,
      () => {},
    );
    await artifacts.asrSentence(state);
    await artifacts.processingAudio(state);
    await expect(artifacts.asrWord(state)).rejects.toThrow(/全部分块转写为空/);
  });

  it("captioner 没给出任何语音段时不切块（整体报错）", async () => {
    const state = stateOf(outDir);
    const artifacts = new TranscribeArtifacts(
      () => {},
      makeIO({ 0: [] }, { 0: 0 }),
      () => {},
    );
    await artifacts.asrSentence(state);
    await expect(artifacts.processingAudio(state)).rejects.toThrow(/没有任何可转写的音频块/);
  });

  it("单块失败即整体抛错（不吞错）", async () => {
    const clips: ClipRange[] = [
      { start: 0, end: 180 },
      { start: 180, end: 200 },
    ];
    const state = stateOf(outDir, clips);
    const io = makeIO(
      {
        0: [{ beginMs: 0, endMs: 180_000 }],
        1: [{ beginMs: 0, endMs: 20_000 }],
      },
      { 0: 180_000, 1: 20_000 },
      { failOnChunk: "u1-c0" },
    );
    const artifacts = new TranscribeArtifacts(
      () => {},
      io,
      () => {},
    );
    await artifacts.asrSentence(state);
    await artifacts.processingAudio(state);
    await expect(artifacts.asrWord(state)).rejects.toThrow(/块转写失败/);
  });

  it("落盘 caption.json / chunk-plan.json 供人工核对", async () => {
    const { artifacts, state } = await runTranscribe(outDir);
    await artifacts.asrWord(state);

    const caption = await readJson<{ units: Array<{ spans: unknown[] }> }>(paths.caption(outDir));
    const plan = await readJson<{ chunks: unknown[]; maxMs: number }>(paths.chunkPlan(outDir));
    expect(caption.units).toHaveLength(1);
    expect(caption.units[0].spans).toEqual([{ start: 0, end: 5_000 }]);
    expect(plan.chunks).toHaveLength(1);
    expect(plan.maxMs).toBe(180_000);
  });
});

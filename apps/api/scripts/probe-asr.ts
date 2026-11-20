import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import { buildTranscriptFromSentences, parseSyncSentence } from "../src/forge/core/asr";
import { config } from "../src/forge/core/config";

const execFileAsync = promisify(execFile);
const SRC = "D:/english-for-fun/temp/test.aac";
const WAV = "D:/english-for-fun/temp/probe.wav";
const OUT = "D:/english-for-fun/temp/probe-report.json";

async function main() {
  const mod = await import("ffmpeg-static");
  const bin = (mod as { default: string }).default;
  await execFileAsync(bin!, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    SRC,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    WAV,
  ]);
  const buf = await readFile(WAV);
  const durationSec = (buf.length - 44) / 32000;
  console.log(`audio duration ~ ${durationSec.toFixed(2)}s`);

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
    parameters: { format: "wav", sample_rate: "16000", language_hints: ["en"] },
  });
  const headers = {
    Authorization: `Bearer ${config.asrApiKey}`,
    "Content-Type": "application/json",
  };

  const report: Record<string, unknown> = { durationSec, model: config.asrModel };

  // 同步调用：不带 X-DashScope-SSE 头，等待完整结果一次返回
  const t0 = Date.now();
  const resNs = await fetch(config.asrBaseUrl, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(config.asrTimeoutMs),
  });
  const textNs = await resNs.text();
  const rawNs = safeJson(textNs);
  report.sync = {
    httpStatus: resNs.status,
    contentType: resNs.headers.get("content-type"),
    elapsedMs: Date.now() - t0,
    raw: rawNs,
    transcript: (() => {
      try {
        return buildTranscriptFromSentences(parseSyncSentence(rawNs), "en");
      } catch (e) {
        return { error: String(e) };
      }
    })(),
  };
  console.log(`[sync] ${resNs.status} ${Date.now() - t0}ms`);

  await writeFile(OUT, JSON.stringify(report, null, 2), "utf-8");
  console.log(`report -> ${OUT}`);

  // ---------- printed summary ----------
  console.log("\n===== SYNC shape =====");
  console.log(summarizeSync(report.sync as { raw: unknown }));
}

function summarizeSync(ns: { raw: unknown }): string {
  const raw = ns.raw as { output?: Record<string, unknown>; code?: string; message?: string };
  if (!raw || !raw.output) return JSON.stringify(raw).slice(0, 800);
  const out = raw.output;
  const lines = [`output keys: ${Object.keys(out).join(", ")}`];
  lines.push(
    `typeof output.sentence = ${Array.isArray(out.sentence) ? "ARRAY" : typeof out.sentence}`,
  );
  lines.push(`output.text = ${JSON.stringify(out.text)?.slice(0, 300)}`);
  const sentence = out.sentence as Record<string, unknown> | undefined;
  if (sentence && !Array.isArray(sentence)) {
    lines.push(
      `output.sentence: keys=${Object.keys(sentence).join(",")} id=${sentence.sentence_id} ${sentence.begin_time}->${sentence.end_time} words=${((sentence.words as unknown[]) ?? []).length}`,
    );
    lines.push(`output.sentence.text = ${String(sentence.text).slice(0, 200)}`);
  }
  return lines.join("\n");
}

function safeJson(t: string) {
  try {
    return JSON.parse(t);
  } catch {
    return { unparseable: t.slice(0, 2000) };
  }
}

main().catch((e) => {
  console.error("PROBE FAILED:", e);
  process.exit(1);
});

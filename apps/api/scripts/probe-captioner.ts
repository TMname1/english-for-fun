/**
 * 探测脚本：验证 qwen-audio-3.1-captioner 的接入细节。
 *
 * 需要确认三件事（决定 transcribe 子图的投递方式）：
 *   1. getPolicy 返回的 max_file_size_mb 是多少；
 *   2. captioner 是否接受 input.file_url = "oss://..." + X-DashScope-OssResourceResolve: enable
 *      （官方文档写的是 HTTP(S) URL，oss:// 只在 filetrans 上验证过）；
 *   3. 结果里 transcripts[].sentences[] 是否真的带 begin_time / end_time（句级时间戳）。
 *
 * 跑法（cwd 必须是 apps/api，config 会加载 .env）：
 *   pnpm -F api exec tsx scripts/probe-captioner.ts [媒体路径]
 */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";

import { config } from "../src/forge/core/config";

const execFileAsync = promisify(execFile);
const SRC = process.argv[2] ?? "D:/english-for-fun/temp/test.mp4";
const WAV = "D:/english-for-fun/temp/probe-captioner.wav";
const OUT = "D:/english-for-fun/temp/probe-captioner.json";
const MODEL = "qwen-audio-3.1-captioner";

const origin = new URL(config.asrBaseUrl).origin;
const auth = { Authorization: `Bearer ${config.asrApiKey}` };

async function main() {
  // 0) 转码成 16k 单声道 wav（与流水线实际投递的格式一致）
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
  console.log(
    `[wav] ${WAV} ${(buf.length / 1024 / 1024).toFixed(2)} MB, 约 ${((buf.length - 44) / 32000).toFixed(1)}s`,
  );

  // 1) 上传凭证
  const polRes = await fetch(`${origin}/api/v1/uploads?action=getPolicy&model=${MODEL}`, {
    headers: { ...auth, "Content-Type": "application/json" },
  });
  const polText = await polRes.text();
  if (!polRes.ok) throw new Error(`getPolicy HTTP ${polRes.status}: ${polText.slice(0, 600)}`);
  const pol = JSON.parse(polText);
  const d = pol.data ?? pol.output ?? pol;
  const need = ["policy", "signature", "upload_dir", "upload_host", "oss_access_key_id"] as const;
  const missing = need.filter((k) => !d[k]);
  console.log(
    `[policy] host=${d.upload_host} dir=${d.upload_dir} max_file_size_mb=${d.max_file_size_mb} acl=${d.x_oss_object_acl}`,
  );
  if (missing.length)
    throw new Error(`getPolicy 缺字段 ${missing.join(",")}: ${polText.slice(0, 800)}`);

  // 2) OSS 表单上传（与 core/dashscope-oss.ts 的 uploadToTemporaryOss 一致）
  const key = `${String(d.upload_dir).replace(/\/+$/, "")}/${Date.now()}_${basename(WAV)}`;
  const form = new FormData();
  form.append("OSSAccessKeyId", String(d.oss_access_key_id));
  form.append("Signature", String(d.signature));
  form.append("policy", String(d.policy));
  if (d.x_oss_object_acl !== undefined) form.append("x-oss-object-acl", String(d.x_oss_object_acl));
  if (d.x_oss_forbid_overwrite !== undefined)
    form.append("x-oss-forbid-overwrite", String(d.x_oss_forbid_overwrite));
  form.append("key", key);
  form.append("success_action_status", "200");
  form.append("file", new Blob([buf], { type: "audio/wav" }), basename(WAV));

  const upRes = await fetch(String(d.upload_host), { method: "POST", body: form });
  const upText = await upRes.text().catch(() => "");
  console.log(`[upload] HTTP ${upRes.status} (${buf.length} bytes) ${upText.slice(0, 300)}`);
  if (!upRes.ok) throw new Error(`OSS 上传失败: ${upText.slice(0, 800)}`);
  const ossUrl = `oss://${key}`;
  console.log(`[upload] file_url=${ossUrl}`);

  // 3) 提交异步标注任务（captioner 用单值 file_url）
  const submitRes = await fetch(`${origin}/api/v1/services/audio/asr/transcription`, {
    method: "POST",
    headers: {
      ...auth,
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable",
      "X-DashScope-OssResourceResolve": "enable",
    },
    body: JSON.stringify({
      model: MODEL,
      input: { file_url: ossUrl },
      parameters: { channel_id: [0] },
    }),
    signal: AbortSignal.timeout(60000),
  });
  const submitText = await submitRes.text();
  console.log(`[submit] HTTP ${submitRes.status}: ${submitText.slice(0, 500)}`);
  if (!submitRes.ok)
    throw new Error(`提交任务失败（oss:// 可能不被接受）: ${submitText.slice(0, 800)}`);
  const submitJson = JSON.parse(submitText);
  const taskId = submitJson.output?.task_id;
  if (!taskId) throw new Error(`响应无 task_id: ${submitText.slice(0, 800)}`);

  // 4) 轮询
  let taskOutput = submitJson.output;
  const started = Date.now();
  while (["PENDING", "RUNNING", "SUSPENDED", "UNKNOWN"].includes(String(taskOutput?.task_status))) {
    await new Promise((r) => setTimeout(r, 5000));
    const qRes = await fetch(`${origin}/api/v1/tasks/${taskId}`, {
      headers: auth,
      signal: AbortSignal.timeout(60000),
    });
    const qText = await qRes.text();
    if (!qRes.ok) throw new Error(`查询失败 HTTP ${qRes.status}: ${qText.slice(0, 600)}`);
    taskOutput = JSON.parse(qText).output;
    console.log(
      `[poll] ${((Date.now() - started) / 1000).toFixed(0)}s status=${taskOutput?.task_status}`,
    );
    if (Date.now() - started > 20 * 60 * 1000) throw new Error("轮询超时 20 分钟");
  }
  console.log(`[task] final=${taskOutput?.task_status}`);
  if (taskOutput?.task_status !== "SUCCEEDED") {
    throw new Error(`任务未成功: ${JSON.stringify(taskOutput).slice(0, 1200)}`);
  }

  const txUrl =
    taskOutput?.transcription_url ??
    taskOutput?.results?.[0]?.transcription_url ??
    taskOutput?.result?.transcription_url;
  console.log(`[result] transcription_url=${String(txUrl).slice(0, 120)}`);
  if (!txUrl) throw new Error(`无 transcription_url: ${JSON.stringify(taskOutput).slice(0, 1200)}`);

  // 5) 下载并落盘
  const txRes = await fetch(txUrl, { signal: AbortSignal.timeout(60000) });
  const txText = await txRes.text();
  if (!txRes.ok) throw new Error(`下载结果失败 HTTP ${txRes.status}: ${txText.slice(0, 400)}`);
  const txJson = JSON.parse(txText);
  await writeFile(
    OUT,
    JSON.stringify(
      {
        probedAt: new Date().toISOString(),
        model: MODEL,
        source: SRC,
        task: taskOutput,
        transcription: txJson,
      },
      null,
      2,
    ),
    "utf-8",
  );
  console.log(`\n结果已保存 -> ${OUT}`);

  // 6) 结构摘要（本次探测的核心结论）
  console.log("\n===== CAPTIONER 结构 =====");
  console.log("顶层 keys:", Object.keys(txJson).join(", "));
  const transcripts = txJson.transcripts ?? [];
  console.log(`transcripts: ${Array.isArray(transcripts) ? transcripts.length : "非数组"} 项`);
  transcripts.forEach((t: Record<string, unknown>, i: number) => {
    console.log(`  #${i} keys=${Object.keys(t).join(",")} channel=${t.channel_id}`);
    const sentences = (t.sentences ?? []) as Array<Record<string, unknown>>;
    console.log(`  sentences: count=${sentences.length}`);
    sentences
      .slice(0, 6)
      .forEach((s, j) =>
        console.log(
          `    s#${j} id=${s.sentence_id} ${s.begin_time}->${s.end_time} text=${String(s.text ?? "").slice(0, 50)}`,
        ),
      );
    if (typeof t.text === "string") {
      try {
        const p = JSON.parse(t.text) as Record<string, unknown>;
        console.log(`  text(JSON) keys=${Object.keys(p).join(",")}`);
        const segs = (p.speech_segments ?? []) as Array<Record<string, unknown>>;
        console.log(`  speech_segments: count=${segs.length}`);
        segs
          .slice(0, 4)
          .forEach((s, j) =>
            console.log(`    seg#${j} ${s.start}->${s.end} ${String(s.text ?? "").slice(0, 50)}`),
          );
      } catch {
        console.log(`  text 不是 JSON: ${t.text.slice(0, 200)}`);
      }
    }
  });
  console.log("usage:", JSON.stringify(txJson.usage ?? null));
}

main().catch((e) => {
  console.error("CAPTIONER PROBE FAILED:", e);
  process.exit(1);
});

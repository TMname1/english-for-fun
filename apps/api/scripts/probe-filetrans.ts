import { readFile, writeFile } from "node:fs/promises";

import { config } from "../src/forge/core/config";

const SRC = "D:/english-for-fun/temp/test.aac";
const OUT = "D:/english-for-fun/temp/test.json";
const MODEL = "qwen-audio-3.1-asr-flash-filetrans";

const origin = new URL(config.asrBaseUrl).origin;
const auth = { Authorization: `Bearer ${config.asrApiKey}` };

async function main() {
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
  console.log(`[policy] host=${d.upload_host} dir=${d.upload_dir} max=${d.max_file_size_mb}MB`);
  if (missing.length)
    throw new Error(`getPolicy 缺字段 ${missing.join(",")}: ${polText.slice(0, 800)}`);

  // 2) 上传原始 aac，得到 oss:// 临时 URL
  const buf = await readFile(SRC);
  const key = `${String(d.upload_dir).replace(/\/+$/, "")}/${Date.now()}_test.aac`;
  const form = new FormData();
  form.append("OSSAccessKeyId", String(d.oss_access_key_id));
  form.append("Signature", String(d.signature));
  form.append("policy", String(d.policy));
  if (d.x_oss_object_acl !== undefined) form.append("x-oss-object-acl", String(d.x_oss_object_acl));
  if (d.x_oss_forbid_overwrite !== undefined)
    form.append("x-oss-forbid-overwrite", String(d.x_oss_forbid_overwrite));
  form.append("key", key);
  form.append("success_action_status", "200");
  form.append("file", new Blob([buf], { type: "audio/aac" }), "test.aac");

  const upRes = await fetch(String(d.upload_host), { method: "POST", body: form });
  const upText = await upRes.text().catch(() => "");
  console.log(`[upload] HTTP ${upRes.status} (${buf.length} bytes) ${upText.slice(0, 300)}`);
  if (!upRes.ok) throw new Error(`OSS 上传失败: ${upText.slice(0, 800)}`);
  const fileUrl = `oss://${key}`;
  console.log(`[upload] file_url=${fileUrl}`);

  // 3) 提交异步转写任务
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
      input: { file_urls: [fileUrl] },
      parameters: { channel_id: [0], language_hints: ["en"] },
    }),
    signal: AbortSignal.timeout(60000),
  });
  const submitText = await submitRes.text();
  console.log(`[submit] HTTP ${submitRes.status}: ${submitText.slice(0, 500)}`);
  if (!submitRes.ok) throw new Error(`提交任务失败: ${submitText.slice(0, 800)}`);
  const submitJson = JSON.parse(submitText);
  const taskId = submitJson.output?.task_id;
  if (!taskId) throw new Error(`响应无 task_id: ${submitText.slice(0, 800)}`);

  // 4) 轮询任务
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
  console.log(
    `[task] final=${taskOutput?.task_status} usage=${JSON.stringify(submitJson.usage ?? null)}`,
  );
  if (taskOutput?.task_status !== "SUCCEEDED") {
    throw new Error(`任务未成功: ${JSON.stringify(taskOutput).slice(0, 1000)}`);
  }

  const first = (taskOutput?.results ?? [])[0] ?? {};
  console.log(
    `[result] subtask=${first.subtask_status} transcription_url=${String(first.transcription_url).slice(0, 120)}`,
  );
  if (!first.transcription_url)
    throw new Error(`无 transcription_url: ${JSON.stringify(taskOutput).slice(0, 800)}`);

  // 5) 下载识别结果 JSON 并落盘
  const txRes = await fetch(first.transcription_url, { signal: AbortSignal.timeout(60000) });
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
        task: { taskId, taskStatus: taskOutput.task_status, metrics: taskOutput },
        transcriptionUrl: first.transcription_url,
        transcription: txJson,
      },
      null,
      2,
    ),
    "utf-8",
  );
  console.log(`\n结果已保存 -> ${OUT}`);

  console.log("\n===== FILETRANS 结果结构 =====");
  console.log("顶层 keys:", Object.keys(txJson).join(", "));
  for (const [name, t] of Object.entries(txJson.transcripts ?? {}) as never as Array<
    [string, unknown]
  >) {
    void name;
    const tt = t as Record<string, unknown>;
    console.log(`transcript keys: ${Object.keys(tt).join(", ")}`);
    const sentences = (tt.sentences ?? []) as Array<Record<string, unknown>>;
    console.log(`sentences: count=${sentences.length} textLen=${String(tt.text ?? "").length}`);
    sentences.forEach((s, i) =>
      console.log(
        `  #${i} id=${s.sentence_id} ${s.begin_time}->${s.end_time} words=${((s.words as unknown[]) ?? []).length} fixed=${s.fixed} speaker=${s.speaker_id} | ${String(s.text).slice(0, 55)}`,
      ),
    );
  }
  console.log("audio 元信息:", JSON.stringify(txJson.audio_info ?? txJson.properties ?? null));
  console.log(
    "sentences[0] 原样:",
    JSON.stringify(((txJson.transcripts ?? [])[0]?.sentences ?? [])[0], null, 2)?.slice(0, 1200),
  );
}

main().catch((e) => {
  console.error("FILETRANS PROBE FAILED:", e);
  process.exit(1);
});

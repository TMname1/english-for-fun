/**
 * captioner ChatModel 单测：只验证「异步任务的调用顺序、响应怎么搬回 LangChain 消息、
 * 是否真的触发 callback（Langfuse 靠这条链路拿 generation）」，
 * 不覆盖真实 DashScope / OSS 行为（端到端走 transcribe 子图，见 graph/transcribe-*.ts）。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LLMResult } from "@langchain/core/outputs";

import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { AIMessage, HumanMessage } from "@langchain/core/messages";

import { captionResultOf, DashScopeCaptionerChatModel } from "../captioner-model";
import { resolveDashScopeEndpoints } from "../dashscope-oss";

const ENDPOINTS = resolveDashScopeEndpoints("https://x.example");
const RESULT_URL = "https://result.example/r.json";

/** 真实结构（见 scripts/probe-captioner.ts）：sentences 只有一条，边界在 text 的 speech_segments */
const CAPTION_JSON = {
  file_url: "oss://x/y.wav",
  properties: { original_duration_in_milliseconds: 57_005 },
  transcripts: [
    {
      channel_id: 0,
      content_duration_in_milliseconds: 57_005,
      text: JSON.stringify({
        speech_segments: [
          { start: "00:00.00", end: "00:01.60", language: [], text: "[音效=啵] [背景音乐渐起]" },
          { start: "00:01.60", end: "00:04.48", language: ["英文-通用美式"], text: "One more." },
          { start: "00:04.48", end: "00:05.76", language: ["英文-通用美式"], text: "Beast?" },
        ],
      }),
      sentences: [{ begin_time: 0, end_time: 57_005, text: '{"sound_segments":[]}' }],
    },
  ],
};

let dir: string;
let wavPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "captioner-model-"));
  wavPath = join(dir, "unit-0.wav");
  // uploadToTemporaryOss 会 stat + openAsBlob，必须是真实文件
  await writeFile(wavPath, Buffer.alloc(1024, 1));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function res(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function uploadPolicy() {
  return {
    data: {
      policy: "policy-x",
      signature: "sig-x",
      upload_dir: "dashscope/captioner",
      upload_host: "https://oss.example.com/upload",
      oss_access_key_id: "ak-x",
    },
  };
}

/** 按 URL 路由的假 fetch；`taskStatuses` 控制轮询序列 */
function fakeFetch(taskStatuses: string[] = ["RUNNING", "SUCCEEDED"]) {
  const calls: string[] = [];
  let pollIndex = 0;
  const mock = jest.fn(async (url: string, _init?: RequestInit) => {
    calls.push(String(url));
    if (String(url).includes("action=getPolicy")) return res(uploadPolicy());
    if (String(url) === "https://oss.example.com/upload") return res("");
    if (String(url) === ENDPOINTS.transcriptionUrl) return res({ output: { task_id: "task-1" } });
    if (String(url) === ENDPOINTS.taskUrl("task-1")) {
      const status = taskStatuses[Math.min(pollIndex, taskStatuses.length - 1)];
      pollIndex += 1;
      return res({
        output: {
          task_status: status,
          ...(status === "SUCCEEDED" ? { transcription_url: RESULT_URL } : {}),
        },
      });
    }
    if (String(url) === RESULT_URL) return res(CAPTION_JSON);
    throw new Error(`unexpected fetch: ${String(url)}`);
  });
  return { mock, calls };
}

function model(overrides: Partial<ConstructorParameters<typeof DashScopeCaptionerChatModel>[0]>) {
  return new DashScopeCaptionerChatModel({
    wavPath,
    unitIndex: 0,
    baseMs: 0,
    model: "qwen-audio-3.1-captioner",
    apiKey: "sk-test",
    endpoints: ENDPOINTS,
    timeoutMs: 1000,
    pollIntervalMs: 1000,
    pollTimeoutMs: 60_000,
    durationSec: 57,
    fileBytes: 1024,
    ...overrides,
  });
}

/** 可控时钟：sleep 推进时间，便于断言轮询耗时 */
function controlledClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("DashScopeCaptionerChatModel", () => {
  it("按「getPolicy → 上传 OSS → 提交任务 → 轮询 → 下载」顺序调用，并把语音段塞回消息", async () => {
    const { mock, calls } = fakeFetch();
    const clock = controlledClock();

    const msg = await model({ transport: { fetch: mock as never, ...clock } }).invoke([
      new HumanMessage("打标"),
    ]);

    expect(calls).toEqual([
      ENDPOINTS.uploadPolicyUrl("qwen-audio-3.1-captioner"),
      "https://oss.example.com/upload",
      ENDPOINTS.transcriptionUrl,
      ENDPOINTS.taskUrl("task-1"),
      ENDPOINTS.taskUrl("task-1"),
      RESULT_URL,
    ]);

    // 提交时带的是 oss:// 地址与异步任务必需的头
    const submitInit = mock.mock.calls[2][1] as { headers: Record<string, string>; body: string };
    expect(submitInit.headers["X-DashScope-Async"]).toBe("enable");
    expect(JSON.parse(submitInit.body)).toMatchObject({
      model: "qwen-audio-3.1-captioner",
      input: { file_url: expect.stringMatching(/^oss:\/\//) },
      parameters: { channel_id: [0] },
    });

    const parsed = captionResultOf(msg);
    // 音效段被过滤，只剩两句；source 与时长也要带回来
    expect(parsed.spans).toEqual([
      { beginMs: 1_600, endMs: 4_480 },
      { beginMs: 4_480, endMs: 5_760 },
    ]);
    expect(parsed.source).toBe("speech_segments");
    expect(parsed.channelDurationMs).toBe(57_005);
  });

  it("content 是可读摘要（Langfuse 的 output 只取 content），关键指标都在里面", async () => {
    const { mock } = fakeFetch();
    const clock = controlledClock();

    const msg = await model({ transport: { fetch: mock as never, ...clock } }).invoke([
      new HumanMessage("打标"),
    ]);

    expect(msg.content).toContain("task-1");
    expect(msg.content).toContain("2 段语音");
    expect(msg.content).toContain("source=speech_segments");
    expect(msg.content).toContain("轮询 1.0s");
    expect(msg.response_metadata).toMatchObject({
      task_id: "task-1",
      span_count: 2,
      poll_elapsed_ms: 1_000,
      upload_bytes: 1024,
      unit_index: 0,
    });
  });

  it("invocationParams 不含本地绝对路径（否则 trace 里泄露工作目录、无谓放大）", () => {
    const params = model({}).invocationParams();
    expect(params.model).toBe("qwen-audio-3.1-captioner");
    expect(params.mode).toBe("async-task");
    expect(params.wav_name).toBe("unit-0.wav");
    expect(JSON.stringify(params)).not.toContain(dir);
  });

  it("作为 Runnable 会触发 callback（Langfuse 靠这条链路拿 generation）", async () => {
    const { mock } = fakeFetch();
    const clock = controlledClock();
    const starts: unknown[] = [];
    const ends: LLMResult[] = [];
    class Spy extends BaseCallbackHandler {
      name = "spy";
      handleChatModelStart = (_llm: unknown, _messages: unknown, _runId: string) => {
        starts.push(_runId);
      };
      handleLLMEnd = (output: LLMResult) => {
        ends.push(output);
      };
    }
    const spy = new Spy();

    await model({ transport: { fetch: mock as never, ...clock }, callbacks: [spy] }).invoke([
      new HumanMessage("打标"),
    ]);

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(ends[0].generations[0][0].text).toContain("task-1");
  });

  it("轮询失败时报错带 unit 前缀（多 unit 串行时能定位是哪一个）", async () => {
    const { mock } = fakeFetch(["FAILED"]);
    const clock = controlledClock();

    await expect(
      model({ unitIndex: 2, transport: { fetch: mock as never, ...clock } }).invoke([
        new HumanMessage("打标"),
      ]),
    ).rejects.toThrow(/\[captioner\] unit 2 打标失败：.*任务未成功/);
  });

  it("消息里缺 caption_spans 时访问器直接抛错，不静默返回空切块计划", () => {
    expect(() =>
      captionResultOf(
        new AIMessage({
          content: "x",
          response_metadata: { source: "speech_segments" },
        }),
      ),
    ).toThrow(/没有 caption_spans/);
  });
});

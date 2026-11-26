import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  downloadJson,
  pollAsyncTask,
  resolveDashScopeEndpoints,
  submitAsyncTranscription,
  transcriptionUrlOf,
  uploadToTemporaryOss,
} from "../dashscope-oss";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Recorded {
  url: string;
  init?: RequestInit;
}

describe("resolveDashScopeEndpoints", () => {
  it("从完整同步端点推导出四个端点", () => {
    const e = resolveDashScopeEndpoints(
      "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    );
    expect(e.origin).toBe("https://dashscope.aliyuncs.com");
    expect(e.transcriptionUrl).toBe(
      "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription",
    );
    expect(e.taskUrl("t1")).toBe("https://dashscope.aliyuncs.com/api/v1/tasks/t1");
    expect(e.uploadPolicyUrl("m")).toBe(
      "https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=m",
    );
  });

  it("裸 origin（workspace 域名）也支持", () => {
    const e = resolveDashScopeEndpoints("https://ws-x.cn-beijing.maas.aliyuncs.com");
    expect(e.transcriptionUrl).toBe(
      "https://ws-x.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/asr/transcription",
    );
  });

  it("保留 /api/v1/ 之前的网关前缀", () => {
    const e = resolveDashScopeEndpoints("https://gw.example.com/prefix/api/v1/tasks");
    expect(e.origin).toBe("https://gw.example.com/prefix");
    expect(e.taskUrl("t")).toBe("https://gw.example.com/prefix/api/v1/tasks/t");
  });
});

describe("uploadToTemporaryOss", () => {
  let dir = "";
  let file = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "dashscope-oss-"));
    file = join(dir, "clip 1.wav"); // 带空格：验证 key 的字符安全处理
    await writeFile(file, Buffer.alloc(1024, 1));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function fetchWithPolicy(maxMb = 1024) {
    const calls: Recorded[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("action=getPolicy")) {
        return jsonResponse({
          data: {
            policy: "the-policy",
            signature: "the-signature",
            upload_dir: "dir/sub/",
            upload_host: "https://oss.example.com",
            oss_access_key_id: "the-ak",
            x_oss_object_acl: "private",
            x_oss_forbid_overwrite: "true",
            max_file_size_mb: maxMb,
          },
        });
      }
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it("完整走 getPolicy → 表单上传，返回 oss:// 地址", async () => {
    const { impl, calls } = fetchWithPolicy();
    const endpoints = resolveDashScopeEndpoints("https://dashscope.aliyuncs.com");
    const out = await uploadToTemporaryOss(file, {
      endpoints,
      model: "qwen-audio-3.1-captioner",
      apiKey: "sk-test",
      fetch: impl,
    });

    expect(calls[0].url).toContain(
      "/api/v1/uploads?action=getPolicy&model=qwen-audio-3.1-captioner",
    );
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    expect(calls[1].url).toBe("https://oss.example.com");

    expect(out.ossUrl.startsWith("oss://dir/sub/")).toBe(true);
    expect(out.ossUrl.endsWith("_clip_1.wav")).toBe(true); // 空格被替换
    expect(out.bytes).toBe(1024);

    const form = calls[1].init?.body as FormData;
    expect(form.get("OSSAccessKeyId")).toBe("the-ak");
    expect(form.get("Signature")).toBe("the-signature");
    expect(form.get("policy")).toBe("the-policy");
    expect(form.get("success_action_status")).toBe("200");
    expect(form.get("x-oss-object-acl")).toBe("private");
    expect(form.get("x-oss-forbid-overwrite")).toBe("true");
    expect(form.get("key")).toBe(out.ossUrl.replace("oss://", ""));
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  it("超过 policy 的 max_file_size_mb 时上传前就报错", async () => {
    const { impl } = fetchWithPolicy(0.0005);
    const endpoints = resolveDashScopeEndpoints("https://dashscope.aliyuncs.com");
    await expect(
      uploadToTemporaryOss(file, { endpoints, model: "m", apiKey: "sk-test", fetch: impl }),
    ).rejects.toThrow(/超过临时 OSS 上限/);
  });

  it("凭证缺字段时报错并指出缺哪个", async () => {
    const impl = (async () => jsonResponse({ data: { policy: "p" } })) as unknown as typeof fetch;
    const endpoints = resolveDashScopeEndpoints("https://dashscope.aliyuncs.com");
    await expect(
      uploadToTemporaryOss(file, { endpoints, model: "m", apiKey: "sk-test", fetch: impl }),
    ).rejects.toThrow(/上传凭证缺字段/);
  });

  it("没有 API Key 直接报错", async () => {
    const endpoints = resolveDashScopeEndpoints("https://dashscope.aliyuncs.com");
    await expect(uploadToTemporaryOss(file, { endpoints, model: "m", apiKey: "" })).rejects.toThrow(
      /未配置 API Key/,
    );
  });
});

describe("submitAsyncTranscription", () => {
  it("captioner 用单值 file_url，并带异步 + OSS 解析两个头", async () => {
    const calls: Recorded[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ output: { task_id: "task-1", task_status: "PENDING" } });
    }) as unknown as typeof fetch;

    const out = await submitAsyncTranscription({
      endpoints: resolveDashScopeEndpoints("https://dashscope.aliyuncs.com"),
      model: "qwen-audio-3.1-captioner",
      apiKey: "sk-test",
      fileUrl: "oss://dir/a.wav",
      parameters: { channel_id: [0] },
      fetch: impl,
    });

    expect(out.taskId).toBe("task-1");
    expect(calls[0].url).toBe(
      "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription",
    );
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["X-DashScope-Async"]).toBe("enable");
    expect(headers["X-DashScope-OssResourceResolve"]).toBe("enable");
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.input).toEqual({ file_url: "oss://dir/a.wav" });
    expect(body.parameters).toEqual({ channel_id: [0] });
  });

  it("field=file_urls 时用数组（filetrans 风格）", async () => {
    let body: { input: unknown } = { input: null };
    const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse({ output: { task_id: "t" } });
    }) as unknown as typeof fetch;

    await submitAsyncTranscription({
      endpoints: resolveDashScopeEndpoints("https://x.com"),
      model: "m",
      apiKey: "k",
      fileUrl: "oss://a.wav",
      field: "file_urls",
      fetch: impl,
    });
    expect(body.input).toEqual({ file_urls: ["oss://a.wav"] });
  });

  it("HTTP 失败时报错并带上模型与文件地址", async () => {
    const impl = (async () =>
      jsonResponse({ code: "InvalidParameter" }, 400)) as unknown as typeof fetch;
    await expect(
      submitAsyncTranscription({
        endpoints: resolveDashScopeEndpoints("https://x.com"),
        model: "m",
        apiKey: "k",
        fileUrl: "oss://a.wav",
        fetch: impl,
      }),
    ).rejects.toThrow(/提交标注任务失败（HTTP 400）/);
  });
});

describe("pollAsyncTask", () => {
  const endpoints = resolveDashScopeEndpoints("https://x.com");

  function poller(statuses: string[], finalBody: unknown) {
    let i = 0;
    const impl = (async () => {
      const status = statuses[Math.min(i, statuses.length - 1)];
      i += 1;
      return jsonResponse({
        output: {
          task_id: "t",
          task_status: status,
          ...(status === "SUCCEEDED" ? (finalBody as object) : {}),
        },
      });
    }) as unknown as typeof fetch;
    return impl;
  }

  it("PENDING → RUNNING → SUCCEEDED，返回结果地址", async () => {
    const impl = poller(["PENDING", "RUNNING", "SUCCEEDED"], {
      subtask_status: "SUCCEEDED",
      transcription_url: "https://result/x.json",
    });
    const out = await pollAsyncTask("t", {
      endpoints,
      apiKey: "k",
      intervalMs: 1,
      timeoutMs: 60_000,
      fetch: impl,
      sleep: async () => {},
    });
    expect(out.transcriptionUrl).toBe("https://result/x.json");
  });

  it("FAILED 直接抛错", async () => {
    const impl = poller(["FAILED"], {});
    await expect(
      pollAsyncTask("t", {
        endpoints,
        apiKey: "k",
        intervalMs: 1,
        timeoutMs: 60_000,
        fetch: impl,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/任务未成功（task_status=FAILED/);
  });

  it("超时抛错", async () => {
    let elapsed = 0;
    const impl = poller(["RUNNING"], {});
    await expect(
      pollAsyncTask("t", {
        endpoints,
        apiKey: "k",
        intervalMs: 1,
        timeoutMs: 5_000,
        fetch: impl,
        now: () => elapsed,
        sleep: async () => {
          elapsed += 3_000;
        },
      }),
    ).rejects.toThrow(/轮询超时/);
  });

  it("子任务失败也算失败", async () => {
    const impl = poller(["SUCCEEDED"], { subtask_status: "FAILED" });
    await expect(
      pollAsyncTask("t", {
        endpoints,
        apiKey: "k",
        intervalMs: 1,
        timeoutMs: 60_000,
        fetch: impl,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/子任务失败/);
  });
});

describe("transcriptionUrlOf", () => {
  it("兼容 captioner 扁平字段、filetrans results、result 三种形态", () => {
    expect(transcriptionUrlOf({ transcription_url: "a" })).toBe("a");
    expect(transcriptionUrlOf({ results: [{ transcription_url: "b" }] })).toBe("b");
    expect(transcriptionUrlOf({ result: { transcription_url: "c" } })).toBe("c");
    expect(transcriptionUrlOf({})).toBeUndefined();
  });
});

describe("downloadJson", () => {
  it("解析响应 JSON；非 JSON 报错", async () => {
    const ok = (async () => jsonResponse({ hello: 1 })) as unknown as typeof fetch;
    await expect(downloadJson("https://r", { fetch: ok })).resolves.toEqual({ hello: 1 });

    const bad = (async () => new Response("oops", { status: 200 })) as unknown as typeof fetch;
    await expect(downloadJson("https://r", { fetch: bad })).rejects.toThrow(/不是合法 JSON/);
  });
});

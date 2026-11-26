import { beforeEach, describe, expect, it, vi } from "vitest";

import { uploadForgeJob } from "../forge";

/**
 * 覆盖「浏览器直传 OSS」这条链路：票据 → PUT → 建任务。
 * ofetch 与 XMLHttpRequest 都打桩，验证请求顺序、参数与错误文案。
 */
const hoisted = vi.hoisted(() => {
  const calls: Array<{ url: string; options: any }> = [];
  let responder: (url: string, options: any) => unknown = () => ({});
  return {
    calls,
    reset() {
      calls.length = 0;
      responder = () => ({});
    },
    setResponder(fn: (url: string, options: any) => unknown) {
      responder = fn;
    },
    fetchMock: async (url: string, options: any) => {
      calls.push({ url, options });
      return responder(url, options);
    },
  };
});

vi.mock("ofetch", () => ({
  ofetch: { create: () => hoisted.fetchMock },
}));

class FakeXhr {
  static last: FakeXhr | null = null;
  static status = 200;
  static body = "";

  upload: { onprogress: ((event: any) => void) | null } = { onprogress: null };
  status = 0;
  responseText = "";
  method = "";
  url = "";
  headers: Record<string, string> = {};
  sent: unknown = null;

  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  send(body: unknown) {
    this.sent = body;
    FakeXhr.last = this;
    this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
    setTimeout(() => {
      this.status = FakeXhr.status;
      this.responseText = FakeXhr.body;
      this.onload?.();
    }, 0);
  }
}

function makeFile(name: string, size: number, type = "audio/mpeg"): File {
  const file = new File([new Uint8Array(1)], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

const ticket = {
  key: "course-video/11111111-1111-1111-1111-111111111111.mp3",
  uploadUrl: "https://bucket.oss-cn-hangzhou.aliyuncs.com/course-video/x.mp3?sig",
  expiresInSeconds: 600,
};

const params = { title: "测试", type: "dialogue" as const, language: "en", defer: true };

describe("uploadForgeJob（浏览器直传 OSS）", () => {
  beforeEach(() => {
    hoisted.reset();
    FakeXhr.status = 200;
    FakeXhr.body = "";
    FakeXhr.last = null;
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
  });

  it("先要票据、再 PUT 原始文件、最后只带 videoKey 建任务", async () => {
    const percent: number[] = [];
    hoisted.setResponder((url) => {
      if (url === "/forge/uploads/presign") return ticket;
      if (url === "/forge/jobs/from-upload") return { jobId: "job-1" };
      throw new Error(`unexpected ${url}`);
    });

    const result = await uploadForgeJob({
      file: makeFile("我的素材.mp3", 8 * 1024 * 1024),
      ...params,
      onProgress: (p) => percent.push(p),
    });

    expect(result).toEqual({ jobId: "job-1" });
    expect(hoisted.calls.map((c) => c.url)).toEqual([
      "/forge/uploads/presign",
      "/forge/jobs/from-upload",
    ]);
    expect(hoisted.calls[0].options.body).toEqual({ fileName: "我的素材.mp3" });

    const xhr = FakeXhr.last!;
    expect(xhr.method).toBe("PUT");
    expect(xhr.url).toBe(ticket.uploadUrl);
    expect(xhr.headers["Content-Type"]).toBe("audio/mpeg");
    expect((xhr.sent as File).name).toBe("我的素材.mp3");
    expect(percent).toEqual([0.5, 1]);

    // 建任务不再传文件，只传 key
    expect(hoisted.calls[1].options.body).toMatchObject({
      videoKey: ticket.key,
      title: "测试",
      type: "dialogue",
      defer: true,
    });
    expect(hoisted.calls[1].options.body).not.toHaveProperty("file");
  });

  it("超过 2GB 直接报错，不发任何请求", async () => {
    await expect(
      uploadForgeJob({ file: makeFile("big.mp4", 2 * 1024 * 1024 * 1024 + 1), ...params }),
    ).rejects.toThrow(/2GB/);
    expect(hoisted.calls).toHaveLength(0);
    expect(FakeXhr.last).toBeNull();
  });

  it("空文件直接报错", async () => {
    await expect(uploadForgeJob({ file: makeFile("empty.mp3", 0), ...params })).rejects.toThrow(
      /文件是空的/,
    );
    expect(hoisted.calls).toHaveLength(0);
  });

  it("PUT 失败时把 OSS 的 403 翻译成可读提示，且不建任务", async () => {
    FakeXhr.status = 403;
    FakeXhr.body = "<Error><Code>SignatureDoesNotMatch</Code></Error>";
    hoisted.setResponder((url) => {
      if (url === "/forge/uploads/presign") return ticket;
      throw new Error(`不应请求 ${url}`);
    });

    await expect(uploadForgeJob({ file: makeFile("a.mp3", 1024), ...params })).rejects.toThrow(
      /403 SignatureDoesNotMatch/,
    );
    expect(hoisted.calls).toHaveLength(1);
  });

  it("跨域被拦截（status 0）时提示检查 OSS CORS", async () => {
    FakeXhr.status = 0;
    hoisted.setResponder(() => ticket);

    await expect(uploadForgeJob({ file: makeFile("a.mp3", 1024), ...params })).rejects.toThrow(
      /CORS/,
    );
  });
});

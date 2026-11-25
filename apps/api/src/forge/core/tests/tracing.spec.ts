/**
 * tracing.ts 的开关逻辑：这层一旦判断错，要么整条流水线白跑一遍无 trace，
 * 要么在 CI 里偷偷往外网发数据。所以只测「要不要启用」，不测真实上报。
 */
const KEYS = [
  "LANGFUSE_TRACING",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
];

describe("tracing 开关", () => {
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const key of KEYS) saved[key] = process.env[key];
  });

  afterAll(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    jest.resetModules();
  });

  /** 重置模块缓存后按给定的环境变量重新加载，避免 config 的模块级快照串味 */
  async function loadTracing(env: Record<string, string | undefined>) {
    jest.resetModules();
    for (const key of KEYS) {
      const value = env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return import("../tracing");
  }

  it("没配 key 时整体禁用，newHandler 返回 null", async () => {
    const tracing = await loadTracing({
      LANGFUSE_PUBLIC_KEY: "",
      LANGFUSE_SECRET_KEY: "",
    });
    expect(tracing.tracingEnabled()).toBe(false);
    expect(tracing.newHandler({ sessionId: "job-1" })).toBeNull();
    // 禁用状态下 flush 应当是空操作，不抛也不阻塞
    await expect(tracing.flushTracing()).resolves.toBeUndefined();
  });

  it("只配了 public key（缺 secret）也算没配全", async () => {
    const tracing = await loadTracing({
      LANGFUSE_PUBLIC_KEY: "pk-lf-1111",
      LANGFUSE_SECRET_KEY: "",
    });
    expect(tracing.tracingEnabled()).toBe(false);
  });

  it("LANGFUSE_TRACING=0 可强制关闭（排障用）", async () => {
    const tracing = await loadTracing({
      LANGFUSE_TRACING: "0",
      LANGFUSE_PUBLIC_KEY: "pk-lf-1111",
      LANGFUSE_SECRET_KEY: "sk-lf-2222",
    });
    expect(tracing.tracingEnabled()).toBe(false);
    expect(tracing.newHandler()).toBeNull();
  });

  it("两个 key 齐全时启用", async () => {
    const tracing = await loadTracing({
      LANGFUSE_TRACING: undefined,
      LANGFUSE_PUBLIC_KEY: "pk-lf-1111",
      LANGFUSE_SECRET_KEY: "sk-lf-2222",
      LANGFUSE_BASE_URL: "http://localhost:3002",
    });
    expect(tracing.tracingEnabled()).toBe(true);
  });
});

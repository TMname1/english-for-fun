import type { RunnableConfig } from "@langchain/core/runnables";

import { Command } from "@langchain/langgraph";

import { studioPhase, withRunRoot } from "../../graph/studio-trace";
import { newHandler } from "../../tracing";

/**
 * studio-trace.ts 的 Proxy 包装：这层一旦转发错，Studio 的 thread 状态 / interrupt 会静默失效，
 * 追踪也会退回「每次 ChatOpenAI 一条 trace」。所以重点测三件事：
 *   1. 执行入口被注入 runName（+ handler）；
 *   2. 其它 API 原样转发，且 `this` 必须是真实例（Pregel 有私有方法）；
 *   3. phase 判定认的是 `lg_name`（跨副本的 Command 实例 instanceof 判不出来）。
 */
jest.mock("../../tracing", () => {
  const handler = { name: "fake-handler" };
  return {
    newHandler: jest.fn(() => handler),
    __handler: handler,
  };
});

const fakeHandler = (jest.requireMock("../../tracing") as { __handler: unknown }).__handler;

/** 用真实 class + 私有字段模拟 Pregel：`this` 不是真实例时会抛 TypeError */
class FakeGraph {
  calls: Array<{ method: string; input: unknown; config?: RunnableConfig }> = [];
  checkpointer: unknown = "original";

  #secret(): string {
    return "ok";
  }

  async streamEvents(input: unknown, config?: RunnableConfig) {
    this.calls.push({ method: "streamEvents", input, config });
    return this.#secret();
  }

  async invoke(input: unknown, config?: RunnableConfig) {
    this.calls.push({ method: "invoke", input, config });
    return this.#secret();
  }

  async getState() {
    return { next: this.#secret() };
  }

  getName(): string {
    return "forge";
  }
}

describe("studioPhase", () => {
  it("普通 input 视为 transcribe", () => {
    expect(studioPhase({ params: { mediaPath: "a.mp4", title: "t" } })).toBe("transcribe");
  });

  it("Command 视为 structure-resolve（按 lg_name 判定，不依赖 instanceof）", () => {
    // 跨 @langchain/langgraph 副本时就是这个样子：另一个类，但同样带 lg_name
    class CrossCopyCommand {
      lg_name = "Command";
      resume = { decisions: [] };
      goto: string[] = [];
    }
    expect(studioPhase(new CrossCopyCommand())).toBe("structure-resolve");
    expect(studioPhase(new Command({ resume: { decisions: [] } }))).toBe("structure-resolve");
  });

  it("null / undefined 不炸", () => {
    expect(studioPhase(null)).toBe("transcribe");
    expect(studioPhase(undefined)).toBe("transcribe");
  });
});

describe("withRunRoot", () => {
  beforeEach(() => {
    jest.mocked(newHandler).mockClear();
  });

  it("把 runName 与根 handler 合进 streamEvents 的 config", async () => {
    const traced = withRunRoot(new FakeGraph());
    await traced.streamEvents({ jobId: "j1" }, { configurable: { thread_id: "thread-1" } });

    const config = (traced as unknown as FakeGraph).calls[0].config!;
    expect(config.runName).toBe("forge-transcribe");
    expect(config.callbacks).toEqual([fakeHandler]);
    // thread_id 必须保留：Studio 靠它续跑/查状态
    expect(config.configurable).toEqual({ thread_id: "thread-1" });
    // Langfuse 会话 id 取 thread_id，多轮 resume 才能串起来
    expect(jest.mocked(newHandler).mock.calls[0][0]).toMatchObject({
      sessionId: "thread-1",
      tags: ["forge:transcribe"],
    });
  });

  it("resume 的 Command 走 structure-resolve 命名", async () => {
    const traced = withRunRoot(new FakeGraph());
    await traced.invoke(new Command({ resume: { decisions: [] } }), {});
    expect((traced as unknown as FakeGraph).calls[0].config!.runName).toBe(
      "forge-structure-resolve",
    );
  });

  it("保留 server 已塞的 callbacks（配了 langsmith_project 时会有 tracer）", async () => {
    const tracer = { name: "langchain_tracer" };
    const traced = withRunRoot(new FakeGraph());
    await traced.streamEvents({}, { callbacks: [tracer as never] });
    expect((traced as unknown as FakeGraph).calls[0].config!.callbacks).toEqual([
      tracer,
      fakeHandler,
    ]);
  });

  it("未启用追踪时只注入 runName，不塞 callbacks", async () => {
    jest.mocked(newHandler).mockReturnValueOnce(null);
    const traced = withRunRoot(new FakeGraph());
    await traced.streamEvents({}, {});
    const config = (traced as unknown as FakeGraph).calls[0].config!;
    expect(config.runName).toBe("forge-transcribe");
    expect(config.callbacks).toBeUndefined();
  });

  it("非执行入口的方法转发到真实例（私有字段可用）", async () => {
    const traced = withRunRoot(new FakeGraph());
    await expect(traced.getState()).resolves.toEqual({ next: "ok" });
    expect(traced.getName()).toBe("forge");
  });

  it("属性读写落在真实例上（langgraph-api 会写回 checkpointer / store）", () => {
    const raw = new FakeGraph();
    const traced = withRunRoot(raw);
    traced.checkpointer = "injected";
    expect(raw.checkpointer).toBe("injected");
  });
});

import { Command, isInterrupted, MemorySaver } from "@langchain/langgraph";

import type { ForgeArtifactSource } from "../../graph/artifacts";
import type { ForgeStateUpdate } from "../../graph/state";
import type { StructureProgress } from "../../types";
import { buildForgeGraph } from "../../graph/build";

/** 记录调用顺序的假产物层：完全不碰磁盘与 LLM */
function fakeArtifacts(overrides: Partial<ForgeArtifactSource> = {}) {
  const calls: string[] = [];
  const progress = { success: [], failures: [] } as StructureProgress;

  const base: ForgeArtifactSource = {
    prepare: async () => {
      calls.push("prepare");
      return { stage: "transcoding" };
    },
    transcribe: async () => {
      calls.push("transcribe");
      return { transcriptStat: { segments: 3, wordLevel: true, clipCount: 0 } };
    },
    structureBatch: async () => {
      calls.push("structureBatch");
      return { chains: [{ index: 0, statements: [], spans: [] }], failureCount: 0 };
    },
    retryBatch: async () => {
      calls.push("retryBatch");
      return { failureCount: 0 };
    },
    finalize: async () => {
      calls.push("finalize");
      return { stage: "done" as const, alignRate: 1 };
    },
    readProgress: async () => {
      calls.push("readProgress");
      return progress;
    },
  };
  return { artifacts: { ...base, ...overrides } as ForgeArtifactSource, calls };
}

// 图的 input 由 ForgeInputSchema 校验，params.mediaPath / title 必填（见 state.ts）
const initialState = {
  jobId: "job-1",
  outDir: "/tmp/forge-job-1",
  params: {
    mediaPath: "/tmp/demo.mp4",
    title: "测试课程",
    type: "dialogue" as const,
    language: "en" as const,
  },
};

describe("Forge 图拓扑（fresh 路径）", () => {
  it("无失败句时 prepare → transcribe → structureBatch → finalize，且不进入 reviewGate", async () => {
    const { artifacts, calls } = fakeArtifacts();
    const graph = buildForgeGraph({ emitStage: () => {}, artifacts }).compile();

    const result = await graph.invoke(initialState);
    expect(calls).toEqual(["prepare", "transcribe", "structureBatch", "finalize"]);
    expect(result.stage).toBe("done");
    expect(isInterrupted(result)).toBe(false);
  });

  it("有失败句时停在 reviewGate，不调用 finalize", async () => {
    const { artifacts, calls } = fakeArtifacts({
      structureBatch: async () => {
        calls.push("structureBatch");
        return { chains: [], failureCount: 2, failureIndexes: [1, 4] };
      },
      readProgress: async () => {
        calls.push("readProgress");
        return {
          success: [],
          failures: [
            { index: 1, sentence: "a", attempts: [] },
            { index: 4, sentence: "b", attempts: [] },
          ],
        } as StructureProgress;
      },
    });
    const graph = buildForgeGraph({ emitStage: () => {}, artifacts }).compile({
      checkpointer: new MemorySaver(),
    });

    const result = await graph.invoke(initialState, { configurable: { thread_id: "t" } });
    expect(isInterrupted(result)).toBe(true);
    expect(calls).toContain("readProgress");
    expect(calls).not.toContain("finalize");
    expect(calls).not.toContain("retryBatch");
  });
});

describe("Forge 图 interrupt / resume", () => {
  function setup() {
    const calls: string[] = [];
    const decisionsSeen: unknown[] = [];
    const progress: StructureProgress = {
      success: [{ index: 0, statements: [], spans: [] }],
      failures: [{ index: 2, sentence: "broken", attempts: [] }],
    };

    const artifacts: ForgeArtifactSource = {
      prepare: async () => ({ stage: "transcoding" }),
      transcribe: async () => ({}),
      structureBatch: async () => {
        calls.push("structureBatch");
        return { chains: progress.success.map((c) => ({ ...c, statements: [] })), failureCount: 1 };
      },
      retryBatch: async (state): Promise<ForgeStateUpdate> => {
        calls.push("retryBatch");
        decisionsSeen.push(state.decisions);
        return { failureCount: 0, chains: [{ index: 2, statements: [], spans: [] }] };
      },
      finalize: async () => {
        calls.push("finalize");
        return { stage: "done" };
      },
      readProgress: async () => progress,
    };

    const graph = buildForgeGraph({ emitStage: () => {}, artifacts }).compile({
      checkpointer: new MemorySaver(),
    });
    return { graph, calls, decisionsSeen, progress };
  }

  it("resume 时重放 reviewGate 但不会重跑 structureBatch（不重复计费）", async () => {
    const { graph, calls, decisionsSeen } = setup();
    const config = { configurable: { thread_id: "job-x" } };

    const paused = await graph.invoke(initialState, config);
    expect(isInterrupted(paused)).toBe(true);
    expect(calls).toEqual(["structureBatch"]);

    const finished = await graph.invoke(
      new Command({ resume: { decisions: [{ index: 2, action: "retry" }] } }),
      config,
    );

    // structureBatch 只跑过一次：LLM 结果来自 checkpoint，不会重复计费
    expect(calls.filter((c) => c === "structureBatch")).toHaveLength(1);
    expect(calls).toEqual(["structureBatch", "retryBatch", "finalize"]);
    expect(decisionsSeen[0]).toEqual([{ index: 2, action: "retry" }]);
    expect(isInterrupted(finished)).toBe(false);
  });

  it("重试后仍有失败 → 再次停在 reviewGate（checkpoint 仍可续跑）", async () => {
    const progress: StructureProgress = {
      success: [{ index: 0, statements: [], spans: [] }],
      failures: [{ index: 2, sentence: "broken", attempts: [] }],
    };
    const calls: string[] = [];
    const artifacts: ForgeArtifactSource = {
      prepare: async () => ({}),
      transcribe: async () => ({}),
      structureBatch: async () => {
        calls.push("structureBatch");
        return { chains: [], failureCount: 1 };
      },
      retryBatch: async () => {
        calls.push("retryBatch");
        // 重试后依然不合规
        return { failureCount: 1, failureIndexes: [2] };
      },
      finalize: async () => {
        calls.push("finalize");
        return { stage: "done" };
      },
      readProgress: async () => progress,
    };
    const graph = buildForgeGraph({ emitStage: () => {}, artifacts }).compile({
      checkpointer: new MemorySaver(),
    });
    const config = { configurable: { thread_id: "job-loop" } };

    await graph.invoke(initialState, config);
    const again = await graph.invoke(
      new Command({ resume: { decisions: [{ index: 2, action: "retry" }] } }),
      config,
    );

    expect(isInterrupted(again)).toBe(true);
    expect(calls).toEqual(["structureBatch", "retryBatch"]);
    // 又停在 reviewGate 上，下一轮 resolve 仍能按 thread_id 续跑
    const state = await graph.getState(config);
    expect(state.next).toEqual(["reviewGate"]);
    expect(state.values.round).toBe(1);
  });

  it("连续 3 轮仍有失败时抛错，避免无限重试", async () => {
    const progress: StructureProgress = {
      success: [],
      failures: [{ index: 2, sentence: "broken", attempts: [] }],
    };
    const artifacts: ForgeArtifactSource = {
      prepare: async () => ({}),
      transcribe: async () => ({}),
      structureBatch: async () => ({ failureCount: 1 }),
      retryBatch: async () => ({ failureCount: 1, failureIndexes: [2] }),
      finalize: async () => ({ stage: "done" }),
      readProgress: async () => progress,
    };
    const graph = buildForgeGraph({ emitStage: () => {}, artifacts }).compile({
      checkpointer: new MemorySaver(),
    });
    const config = { configurable: { thread_id: "job-rounds" } };
    const resume = () =>
      graph.invoke(new Command({ resume: { decisions: [{ index: 2, action: "retry" }] } }), config);

    await graph.invoke(initialState, config); // 第 1 次停在 reviewGate（round=0）
    await resume(); // round → 1，重试后仍有失败 → 再次暂停
    await resume(); // round → 2，同上
    // 第 3 次重试后 round=3，reviewGate 拒绝再暂停
    await expect(resume()).rejects.toThrow(/已连续 3 轮仍有/);
  });

  it("决策不覆盖全部失败句时抛错（复用 validateResolveDecisions）", async () => {
    const { graph } = setup();
    const config = { configurable: { thread_id: "job-z" } };
    await graph.invoke(initialState, config);

    await expect(graph.invoke(new Command({ resume: { decisions: [] } }), config)).rejects.toThrow(
      /缺少对失败句的决策/,
    );
  });
});

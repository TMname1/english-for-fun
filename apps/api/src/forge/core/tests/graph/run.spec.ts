/**
 * runForgeGraph 的「能否续跑」判定：只要 checkpoint 不可用就必须回 unavailable，
 * 让 pipeline-runner 退回 legacy（旧任务、拓扑升级、跳过暂停点都靠这条兜底）。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint";

import { paths } from "../../forge";
import { GRAPH_VERSION } from "../../graph/build";
import { FileCheckpointSaver } from "../../graph/file-checkpointer";
import { runForgeGraph } from "../../graph/run";

const params = { type: "dialogue" as const, language: "en" };

async function seedCheckpoint(outDir: string, threadId: string, graphVersion = GRAPH_VERSION) {
  const saver = new FileCheckpointSaver(paths.checkpoint(outDir), { graphVersion });
  const checkpoint = {
    v: 4,
    id: "cp-1",
    ts: new Date().toISOString(),
    channel_values: {},
    channel_versions: {},
    versions_seen: {},
  } as Checkpoint;
  await saver.put(
    { configurable: { thread_id: threadId } },
    checkpoint,
    { source: "loop", step: 1, parents: {} } as CheckpointMetadata,
    {},
  );
}

describe("runForgeGraph 的 resolve 可用性判定", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "forge-run-"));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it("没有 checkpoint（旧任务）→ unavailable，由调用方降级 legacy", async () => {
    const outcome = await runForgeGraph(
      { phase: "structure-resolve", jobId: "job-1", outDir, params },
      () => {},
    );
    expect(outcome).toBe("unavailable");
  });

  it("checkpoint 属于别的任务 → unavailable（防止串号）", async () => {
    await seedCheckpoint(outDir, "another-job");
    const outcome = await runForgeGraph(
      { phase: "structure-resolve", jobId: "job-1", outDir, params },
      () => {},
    );
    expect(outcome).toBe("unavailable");
  });

  it("checkpoint 的拓扑版本不符（图结构已升级）→ unavailable", async () => {
    await seedCheckpoint(outDir, "job-1", GRAPH_VERSION + 1);
    const outcome = await runForgeGraph(
      { phase: "structure-resolve", jobId: "job-1", outDir, params },
      () => {},
    );
    expect(outcome).toBe("unavailable");
  });

  it("checkpoint 在位但没停在 reviewGate（已收尾）→ unavailable", async () => {
    await seedCheckpoint(outDir, "job-1");
    const outcome = await runForgeGraph(
      { phase: "structure-resolve", jobId: "job-1", outDir, params },
      () => {},
    );
    expect(outcome).toBe("unavailable");
  });

  it("checkpoint 文件损坏 → unavailable（不走异常路径）", async () => {
    await writeFile(paths.checkpoint(outDir), "{ broken", "utf-8");
    const outcome = await runForgeGraph(
      { phase: "structure-resolve", jobId: "job-1", outDir, params },
      () => {},
    );
    expect(outcome).toBe("unavailable");
  });
});

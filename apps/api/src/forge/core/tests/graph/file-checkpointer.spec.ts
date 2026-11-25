import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint";

import { FileCheckpointSaver } from "../../graph/file-checkpointer";

function checkpointOf(
  id: string,
  parentId: string | null,
  values: Record<string, unknown> = {},
): Checkpoint {
  return {
    v: 4,
    id,
    ts: new Date().toISOString(),
    channel_values: values,
    channel_versions: {},
    versions_seen: {},
    ...(parentId ? { parent_checkpoint_id: parentId } : {}),
  } as Checkpoint;
}

function metaOf(step: number): CheckpointMetadata {
  return { source: "loop", step, parents: {} } as CheckpointMetadata;
}

const THREAD = "job-1";
const config = (extra: Record<string, unknown> = {}) => ({
  configurable: { thread_id: THREAD, checkpoint_ns: "", ...extra },
});

describe("FileCheckpointSaver", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-ckpt-"));
    file = join(dir, "graph.checkpoint.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("put → getTuple 往返，保留 undefined 与嵌套结构", async () => {
    const saver = new FileCheckpointSaver(file);
    const cp = checkpointOf("cp1", null, {
      chains: [{ index: 0, statements: [], spans: undefined }],
      note: undefined,
      nested: { list: [1, 2, 3], flag: false },
    });

    const returned = await saver.put(config(), cp, metaOf(0), { chains: 1 });
    expect(returned.configurable?.checkpoint_id).toBe("cp1");

    // 新实例强制从磁盘读，验证真的落盘了
    const reopened = new FileCheckpointSaver(file);
    const tuple = await reopened.getTuple(config());
    expect(tuple?.checkpoint.id).toBe("cp1");
    expect(tuple?.checkpoint.channel_versions).toEqual({ chains: 1 });
    const values = tuple?.checkpoint.channel_values as Record<string, unknown>;
    expect(values.nested).toEqual({ list: [1, 2, 3], flag: false });
    const chains = values.chains as Array<Record<string, unknown>>;
    expect(chains[0].index).toBe(0);
    // undefined 经过 JsonPlusSerializer 仍是 undefined，而不是被抹成 null
    expect(chains[0].spans).toBeUndefined();
    expect(tuple?.metadata?.step).toBe(0);
  });

  it("parentConfig 指向上一条 checkpoint，list 按 step 倒序并支持 limit/before", async () => {
    const saver = new FileCheckpointSaver(file);
    await saver.put(config(), checkpointOf("cp1", null), metaOf(0), {});
    await saver.put(config(), checkpointOf("cp2", "cp1"), metaOf(1), {});
    await saver.put(config(), checkpointOf("cp3", "cp2"), metaOf(2), {});

    const latest = await saver.getTuple(config());
    expect(latest?.checkpoint.id).toBe("cp3");
    expect(latest?.parentConfig?.configurable?.checkpoint_id).toBe("cp2");

    const byId = await saver.getTuple(config({ checkpoint_id: "cp1" }));
    expect(byId?.checkpoint.id).toBe("cp1");
    expect(byId?.parentConfig).toBeUndefined();

    const all: string[] = [];
    for await (const tuple of saver.list(config())) all.push(tuple.checkpoint.id);
    expect(all).toEqual(["cp3", "cp2", "cp1"]);

    const limited: string[] = [];
    for await (const tuple of saver.list(config(), { limit: 2 })) limited.push(tuple.checkpoint.id);
    expect(limited).toEqual(["cp3", "cp2"]);

    const older: string[] = [];
    for await (const tuple of saver.list(config({ checkpoint_id: "cp3" })))
      older.push(tuple.checkpoint.id);
    expect(older).toEqual(["cp2", "cp1"]);
  });

  it("putWrites 按 (taskPath, taskId, idx) 排序返回，并幂等覆盖同一写入", async () => {
    const saver = new FileCheckpointSaver(file);
    const cfg = await saver.put(config(), checkpointOf("cp1", null), metaOf(0), {});

    await saver.putWrites(cfg, [["taskB", { v: 1 }]], "t2", "b");
    await saver.putWrites(cfg, [["taskA", { v: 2 }]], "t1", "a");
    // 同一 (task, idx) 再写一次应覆盖而不是追加
    await saver.putWrites(cfg, [["taskA", { v: 3 }]], "t1", "a");
    await saver.putWrites(cfg, [["__interrupt__", [{ id: "i1", value: {} }]]], "t3", "c");

    const tuple = await new FileCheckpointSaver(file).getTuple(config());
    // CheckpointPendingWrite = [taskId, channel, value]
    const pending = (tuple?.pendingWrites ?? []) as Array<[string, string, unknown]>;
    const channels = pending.map(([, channel]) => channel);
    // 排序键是 (taskPath, taskId, idx)：a(taskA) → b(taskB) → c(__interrupt__)
    expect(channels).toEqual(["taskA", "taskB", "__interrupt__"]);
    expect(pending.find(([, channel]) => channel === "taskA")?.[2]).toEqual({ v: 3 });
  });

  it("超过 keep 时裁剪最旧的 checkpoint 及其 writes", async () => {
    const saver = new FileCheckpointSaver(file, { keep: 2 });
    for (let i = 0; i < 5; i++) {
      const cfg = await saver.put(
        config(),
        checkpointOf(`cp${i}`, i ? `cp${i - 1}` : null),
        metaOf(i),
        {},
      );
      await saver.putWrites(cfg, [["state", { i }]], "task", "p");
    }

    const ids: string[] = [];
    for await (const tuple of saver.list(config())) ids.push(tuple.checkpoint.id);
    expect(ids).toEqual(["cp4", "cp3"]);

    const raw = JSON.parse(await readFile(file, "utf-8")) as {
      writes: Array<{ checkpointId: string }>;
    };
    expect(raw.writes.every((w) => ["cp3", "cp4"].includes(w.checkpointId))).toBe(true);
  });

  it("写入是原子的：不残留 .tmp，文件始终是完整 JSON", async () => {
    const saver = new FileCheckpointSaver(file);
    await saver.put(config(), checkpointOf("cp1", null), metaOf(0), {});
    expect(existsSync(`${file}.tmp`)).toBe(false);
    const raw = JSON.parse(await readFile(file, "utf-8")) as {
      version: number;
      checkpoints: unknown[];
    };
    expect(raw.version).toBe(1);
    expect(raw.checkpoints).toHaveLength(1);
  });

  it("文件损坏 / 不存在时按空处理，inspect 报告不可用", async () => {
    const missing = new FileCheckpointSaver(file);
    await expect(missing.getTuple(config())).resolves.toBeUndefined();
    await expect(missing.inspect()).resolves.toEqual({
      exists: false,
      threadId: null,
      graphVersion: null,
    });

    await writeFile(file, "{ not json", "utf-8");
    const broken = new FileCheckpointSaver(file);
    await expect(broken.getTuple(config())).resolves.toBeUndefined();
    expect((await broken.inspect()).exists).toBe(false);
  });

  it("inspect 暴露 threadId 与 graphVersion，供 runner 判断能否续跑", async () => {
    const saver = new FileCheckpointSaver(file, { graphVersion: 7 });
    await saver.put(config(), checkpointOf("cp1", null), metaOf(0), {});
    await expect(saver.inspect()).resolves.toEqual({
      exists: true,
      threadId: THREAD,
      graphVersion: 7,
    });
  });

  it("deleteThread 清掉该线程的全部 checkpoint 与 writes", async () => {
    const saver = new FileCheckpointSaver(file);
    const cfg = await saver.put(config(), checkpointOf("cp1", null), metaOf(0), {});
    await saver.putWrites(cfg, [["state", { i: 1 }]], "task", "p");

    await saver.deleteThread(THREAD);
    await expect(saver.getTuple(config())).resolves.toBeUndefined();
    expect((await saver.inspect()).exists).toBe(false);
  });

  it("缺少 thread_id 时抛错（防止不同任务串号）", async () => {
    const saver = new FileCheckpointSaver(file);
    await expect(saver.getTuple({ configurable: {} })).rejects.toThrow("thread_id");
  });

  it("与真实图配合：换新进程（新 saver 实例）仍能从 interrupt 续跑", async () => {
    const { Annotation, Command, END, START, StateGraph, interrupt } = await import(
      "@langchain/langgraph"
    );
    const State = Annotation.Root({
      count: Annotation<number>({ reducer: (_p, n) => n, default: () => 0 }),
      verdict: Annotation<string | null>({ reducer: (_p, n) => n, default: () => null }),
    });
    const build = (saver: FileCheckpointSaver) =>
      new StateGraph(State)
        .addNode("work", async () => ({ count: 3 }))
        .addNode("gate", async (state) => {
          const decision = interrupt({ count: state.count });
          return { verdict: String(decision) };
        })
        .addEdge(START, "work")
        .addEdge("work", "gate")
        .addEdge("gate", END)
        .compile({ checkpointer: saver });

    const cfg = { configurable: { thread_id: "restart" } };
    const paused = (await build(new FileCheckpointSaver(file)).invoke({ count: 0 }, cfg)) as {
      __interrupt__?: unknown;
    };
    expect(paused.__interrupt__).toBeTruthy();

    // 模拟子进程退出后重新拉起
    const resumed = await build(new FileCheckpointSaver(file)).invoke(
      new Command({ resume: "ok" }),
      cfg,
    );
    expect(resumed.verdict).toBe("ok");
    expect(resumed.count).toBe(3);
  });

  it("挂编译子图时子图 checkpoint 写进嵌套 ns：仍是单文件，父子互不串读", async () => {
    const { Annotation, END, START, StateGraph } = await import("@langchain/langgraph");

    const ChildState = Annotation.Root({
      count: Annotation<number>({ reducer: (_p, n) => n, default: () => 0 }),
    });
    const child = new StateGraph(ChildState)
      .addNode("work", async () => ({ count: 2 }))
      .addEdge(START, "work")
      .addEdge("work", END)
      // 不传 checkpointer：运行期由父图经 CONFIG_KEY_CHECKPOINTER 借出同一个 saver
      .compile();

    const ParentState = Annotation.Root({
      tag: Annotation<string>({ reducer: (_p, n) => n, default: () => "" }),
    });
    const parent = new StateGraph(ParentState)
      .addNode("child", child)
      .addEdge(START, "child")
      .addEdge("child", END)
      .compile({ checkpointer: new FileCheckpointSaver(file) });

    await parent.invoke({ tag: "p" }, config());

    // 单文件里应该同时出现父 ns（空串）与子图 ns（child:<taskId>）
    const raw = JSON.parse(await readFile(file, "utf-8")) as {
      checkpoints: Array<{ ns: string; id: string }>;
    };
    const namespaces = [...new Set(raw.checkpoints.map((c) => c.ns))];
    expect(namespaces).toContain("");
    const childNs = namespaces.find((ns) => ns.startsWith("child"));
    expect(childNs).toBeDefined();

    // 新实例强制从磁盘读：两个 ns 各自能取回，且互不串值
    const reopened = new FileCheckpointSaver(file);
    const parentTuple = await reopened.getTuple(config());
    const childTuple = await reopened.getTuple(config({ checkpoint_ns: childNs }));
    expect(parentTuple?.checkpoint.id).not.toBe(childTuple?.checkpoint.id);
    expect((childTuple?.checkpoint.channel_values as { count?: number }).count).toBe(2);
    const parentValues = parentTuple?.checkpoint.channel_values as {
      tag?: string;
      count?: number;
    };
    expect(parentValues.tag).toBe("p");
    expect(parentValues.count).toBeUndefined();

    // deleteThread 一次清掉两个 ns 的行（跨 ns 语义）
    await reopened.deleteThread(THREAD);
    const after = JSON.parse(await readFile(file, "utf-8")) as { checkpoints: unknown[] };
    expect(after.checkpoints).toHaveLength(0);
  });
});

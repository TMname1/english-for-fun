/**
 * 单文件 checkpointer：把 LangGraph 的 checkpoint 序列化写进 `outDir/graph.checkpoint.json`。
 *
 * 为什么是「单文件」而不是目录：forge 的持久化靠 `ForgeService.ARTIFACT_FILES` 这份
 * **顶层文件名白名单**（上传到对象存储 forge/<jobId>/）与 `resolveFailures` 的回拉列表，
 * 目录需要递归遍历与 key 结构还原；单文件只需各加一项。
 *
 * 序列化顺序固定：checkpoint / write 的值都过 `serde.dumpsTyped`（JsonPlusSerializer），
 * 再 base64 存字符串 —— 这样 `undefined`、`Map`、`Uint8Array` 都能原样往返，
 * 整个文件仍是合法 JSON，可以直接以 application/json 上传。
 */
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ChannelVersions,
  Checkpoint,
  CheckpointListOptions,
  CheckpointMetadata,
  CheckpointTuple,
  PendingWrite,
  SerializerProtocol,
} from "@langchain/langgraph-checkpoint";

import { BaseCheckpointSaver, WRITES_IDX_MAP } from "@langchain/langgraph-checkpoint";

/** 文件格式版本：内部结构变化时 bump，旧文件按「不可用」处理 */
const STORE_VERSION = 1 as const;

export interface FileCheckpointHead {
  exists: boolean;
  /** 文件里记录的线程 id；与调用方期望不一致说明不是同一个任务 */
  threadId: string | null;
  /** 生成该 checkpoint 的图拓扑版本 */
  graphVersion: number | null;
}

interface StoredCheckpoint {
  threadId: string;
  ns: string;
  id: string;
  parentId: string | null;
  step: number;
  /** 单调递增序号：同一 step 多份时的稳定排序依据 */
  seq: number;
  type: string;
  /** base64(serde.dumpsTyped(value)[1]) */
  payload: string;
  metadata: CheckpointMetadata;
}

interface StoredWrite {
  threadId: string;
  ns: string;
  checkpointId: string;
  taskId: string;
  taskPath: string;
  idx: number;
  channel: string;
  type: string;
  payload: string;
}

interface StoreFile {
  version: number;
  threadId: string | null;
  graphVersion: number;
  savedAt: string;
  seq: number;
  checkpoints: StoredCheckpoint[];
  writes: StoredWrite[];
}

function emptyStore(graphVersion: number): StoreFile {
  return {
    version: STORE_VERSION,
    threadId: null,
    graphVersion,
    savedAt: new Date(0).toISOString(),
    seq: 0,
    checkpoints: [],
    writes: [],
  };
}

function threadOf(config: RunnableConfig): { threadId: string; ns: string; checkpointId?: string } {
  const configurable = (config?.configurable ?? {}) as Record<string, unknown>;
  const threadId = configurable.thread_id;
  if (typeof threadId !== "string" || threadId.length === 0) {
    throw new Error("[forge] checkpointer 缺少 thread_id");
  }
  const ns = typeof configurable.checkpoint_ns === "string" ? configurable.checkpoint_ns : "";
  const checkpointId =
    typeof configurable.checkpoint_id === "string" ? configurable.checkpoint_id : undefined;
  return { threadId, ns, checkpointId };
}

export interface FileCheckpointSaverOptions {
  /** 每个 (thread, ns) 保留最近多少份 checkpoint；必须 >= 2 才能一直 resume */
  keep?: number;
  /** 图拓扑版本，写入文件头，恢复时交叉校验 */
  graphVersion?: number;
  serde?: SerializerProtocol;
}

export class FileCheckpointSaver extends BaseCheckpointSaver {
  private readonly keep: number;
  private readonly graphVersion: number;
  private store: StoreFile | null = null;
  /** 所有写操作串行化：避免并发 rename 交错 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    options: FileCheckpointSaverOptions = {},
  ) {
    super(options.serde);
    this.keep = Math.max(2, options.keep ?? 8);
    this.graphVersion = options.graphVersion ?? 1;
  }

  /** 轻量探测：只看文件头，不反序列化 checkpoint（runner 决定是否降级 legacy 用） */
  async inspect(): Promise<FileCheckpointHead> {
    try {
      await stat(this.file);
    } catch {
      return { exists: false, threadId: null, graphVersion: null };
    }
    const store = await this.load();
    return {
      exists: store.checkpoints.length > 0,
      threadId: store.threadId,
      graphVersion: store.graphVersion,
    };
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { threadId, ns, checkpointId } = threadOf(config);
    const store = await this.load();
    const candidates = store.checkpoints
      .filter((c) => c.threadId === threadId && c.ns === ns)
      .sort((a, b) => b.step - a.step || b.seq - a.seq);
    const hit = checkpointId ? candidates.find((c) => c.id === checkpointId) : candidates[0];
    if (!hit) return undefined;
    return this.toTuple(store, hit);
  }

  async *list(
    config: RunnableConfig,
    options: CheckpointListOptions = {},
  ): AsyncGenerator<CheckpointTuple> {
    const { threadId, ns, checkpointId: beforeId } = threadOf(config);
    const store = await this.load();
    let rows = store.checkpoints
      .filter((c) => c.threadId === threadId && c.ns === ns)
      .sort((a, b) => b.step - a.step || b.seq - a.seq);

    if (beforeId) {
      const before = rows.find((c) => c.id === beforeId);
      if (before) {
        rows = rows.filter(
          (c) => c.step < before.step || (c.step === before.step && c.seq < before.seq),
        );
      }
    }
    if (options.filter) {
      rows = rows.filter((c) => matchesFilter(c.metadata, options.filter!));
    }
    if (typeof options.limit === "number") {
      rows = rows.slice(0, options.limit);
    }
    for (const row of rows) {
      yield await this.toTuple(store, row);
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const { threadId, ns } = threadOf(config);
    // channel_versions 由框架给出新版本，这里只做合并；自己自增会与 versions_seen 不一致
    const withVersions: Checkpoint = {
      ...checkpoint,
      channel_versions: { ...checkpoint.channel_versions, ...newVersions },
    };
    const serialized = await this.serialize(withVersions);

    await this.mutate((store) => {
      store.threadId = threadId;
      store.graphVersion = this.graphVersion;
      const seq = ++store.seq;
      store.checkpoints.push({
        threadId,
        ns,
        id: checkpoint.id,
        parentId:
          (checkpoint as { parent_checkpoint_id?: string | null }).parent_checkpoint_id ?? null,
        step: typeof metadata?.step === "number" ? metadata.step : 0,
        seq,
        type: serialized.type,
        payload: serialized.payload,
        metadata: metadata ?? ({} as CheckpointMetadata),
      });
      this.prune(store, threadId, ns);
    });

    // 必须返回带新 checkpoint_id 的 config，否则框架拿不到 parent 链与 resume 起点
    return {
      ...config,
      configurable: { ...config.configurable, checkpoint_ns: ns, checkpoint_id: checkpoint.id },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath?: string,
  ): Promise<void> {
    const { threadId, ns, checkpointId } = threadOf(config);
    if (!checkpointId) {
      throw new Error("[forge] putWrites 缺少 checkpoint_id");
    }
    const serialized = await Promise.all(
      writes.map(async ([channel, value], i) => ({
        channel,
        // 特殊 channel（__interrupt__ / __error__ …）用固定负下标，其余按位置
        idx: WRITES_IDX_MAP[channel] ?? i,
        ...(await this.serialize(value)),
      })),
    );

    await this.mutate((store) => {
      store.threadId = threadId;
      store.graphVersion = this.graphVersion;
      for (const item of serialized) {
        const next: StoredWrite = {
          threadId,
          ns,
          checkpointId,
          taskId,
          taskPath: taskPath ?? "",
          idx: item.idx,
          channel: item.channel,
          type: item.type,
          payload: item.payload,
        };
        // 同 (checkpoint, task, idx) 覆盖写入 —— 框架可能对同一 task 增量补写
        store.writes = store.writes.filter(
          (w) =>
            !(
              w.threadId === next.threadId &&
              w.ns === next.ns &&
              w.checkpointId === next.checkpointId &&
              w.taskId === next.taskId &&
              w.idx === next.idx
            ),
        );
        store.writes.push(next);
      }
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.mutate((store) => {
      store.checkpoints = store.checkpoints.filter((c) => c.threadId !== threadId);
      store.writes = store.writes.filter((w) => w.threadId !== threadId);
      if (store.threadId === threadId) store.threadId = null;
    });
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  private async toTuple(store: StoreFile, row: StoredCheckpoint): Promise<CheckpointTuple> {
    const checkpoint = (await this.deserialize(row.type, row.payload)) as Checkpoint;
    const pendingWrites = store.writes
      .filter((w) => w.threadId === row.threadId && w.ns === row.ns && w.checkpointId === row.id)
      // 按 (taskPath, taskId, idx) 排序：框架依赖这个顺序回放 superstep 的写入
      .sort(
        (a, b) =>
          a.taskPath.localeCompare(b.taskPath) || a.taskId.localeCompare(b.taskId) || a.idx - b.idx,
      );

    return {
      config: {
        configurable: {
          thread_id: row.threadId,
          checkpoint_ns: row.ns,
          checkpoint_id: row.id,
        },
      },
      checkpoint,
      metadata: row.metadata,
      parentConfig: row.parentId
        ? {
            configurable: {
              thread_id: row.threadId,
              checkpoint_ns: row.ns,
              checkpoint_id: row.parentId,
            },
          }
        : undefined,
      pendingWrites: await Promise.all(
        pendingWrites.map(
          async (w) =>
            [w.taskId, w.channel, await this.deserialize(w.type, w.payload)] as [
              string,
              string,
              unknown,
            ],
        ),
      ),
    };
  }

  /** 只保留最近 keep 份 checkpoint，并清掉挂在其上的 writes */
  private prune(store: StoreFile, threadId: string, ns: string): void {
    const scope = store.checkpoints
      .filter((c) => c.threadId === threadId && c.ns === ns)
      .sort((a, b) => b.step - a.step || b.seq - a.seq);
    if (scope.length <= this.keep) return;
    const dropped = new Set(scope.slice(this.keep).map((c) => c.id));
    store.checkpoints = store.checkpoints.filter(
      (c) => !(c.threadId === threadId && c.ns === ns && dropped.has(c.id)),
    );
    store.writes = store.writes.filter(
      (w) => !(w.threadId === threadId && w.ns === ns && dropped.has(w.checkpointId)),
    );
  }

  private async load(): Promise<StoreFile> {
    if (this.store) return this.store;
    try {
      const raw = await readFile(this.file, "utf-8");
      const parsed = JSON.parse(raw) as StoreFile;
      if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.checkpoints)) {
        throw new Error(`checkpoint 文件版本不匹配：${String(parsed?.version)}`);
      }
      this.store = parsed;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      // 文件不存在 / 内容损坏都按「空 store」处理：上层探测不到 checkpoint 就会降级 legacy
      if (code !== "ENOENT") {
        console.warn(
          `[forge] checkpoint 文件不可读，按空处理（${this.file}）：${(error as Error)?.message ?? error}`,
        );
      }
      this.store = emptyStore(this.graphVersion);
    }
    return this.store;
  }

  /** 串行 + 原子落盘：先写 .tmp 再 rename，避免 SIGTERM 时写出半截 JSON */
  private mutate(fn: (store: StoreFile) => void): Promise<void> {
    const run = async (): Promise<void> => {
      const store = await this.load();
      fn(store);
      store.savedAt = new Date().toISOString();
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, `${JSON.stringify(store)}\n`, "utf-8");
      await rename(tmp, this.file);
    };
    // 前一次失败不能让后续写入全部失败：吞掉错误继续排队，但本次调用照常抛出
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async serialize(value: unknown): Promise<{ type: string; payload: string }> {
    const [type, bytes] = await this.serde.dumpsTyped(value);
    return { type, payload: Buffer.from(bytes).toString("base64") };
  }

  private async deserialize(type: string, payload: string): Promise<unknown> {
    return await this.serde.loadsTyped(type, Buffer.from(payload, "base64"));
  }
}

function matchesFilter(metadata: CheckpointMetadata, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(
    ([key, expected]) => (metadata as Record<string, unknown>)?.[key] === expected,
  );
}

/** 清理遗留的 .tmp（进程被强杀时可能残留），供 runner 启动时调用 */
export async function cleanupCheckpointTmp(file: string): Promise<void> {
  await unlink(`${file}.tmp`).catch(() => undefined);
}

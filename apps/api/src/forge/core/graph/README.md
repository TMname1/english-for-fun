# Forge 图编排（`core/graph`）

Forge 流水线的 LangGraph 版本：把原来「命令式阶段函数」的 forge 流程表达成一张
`StateGraph`。**节点只做编排，磁盘/LLM 都下沉到 `artifacts.ts`**，这样图可单测（注入假
artifacts，不碰磁盘和模型），也可以在不改拓扑的情况下替换实现。

与 legacy（`../forge.ts` + `pipeline-runner.ts`）的关系：

- 由 `FORGE_ORCHESTRATOR=graph` 开启，缺省仍是 legacy；
- 两条路径**共用同一批原语**（`prepareRun` / `transcribeRun` / `loadStructureInput` /
  `finalizeCourse` / `mergeResolveChains`），落盘产物必须逐字段一致；
- `needs_fix` 在图里 = `interrupt`，checkpoint 不可用时会返回 `unavailable` 让调用方降级 legacy。

---

## 2. 每个节点的作用

| 节点             | 谁实现                     | 干什么                                                                                                                                      | 读/写的产物                                                                    |
| ---------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `prepare`        | `artifacts.prepare`        | 校验 `mediaPath` / `title`；写 `meta.json`；用 `normalizeClips` 规整切片区间并把结果回写 state（`transcribe` 依赖它）                       | 写 `meta.json`                                                                 |
| `transcribe`     | `artifacts.transcribe`     | 转码 → ASR → 预处理（断句、词级时间戳）；过程中发 `transcoding` / `transcribing` 阶段事件                                                   | 写 `transcript.json`、`transcript.raw.json`、`clips.json`                      |
| `structureBatch` | `artifacts.structureBatch` | 读取 transcript，**一句一次 LLM 调用**并发生成组装链（`generateDraftCollected`），汇总成功链与失败句；有失败就先落盘进度快照                | 读 `transcript.json`；写 `structure.progress.json`（仅失败时）                 |
| `reviewGate`     | `nodes.reviewGate`         | **纯节点**：只 `readProgress` 读失败清单，然后 `interrupt(payload)` 挂起等人；resume 后校验决策（`validateResolveDecisions`）并 `round + 1` | 只读 `structure.progress.json`                                                 |
| `retryBatch`     | `artifacts.retryBatch`     | 按决策分流：`retry` 句重跑 LLM，`delete` 句丢弃，和已成功句合并（`mergeResolveChains`）；仍有失败则再落盘进度                               | 读 `transcript.json` + `structure.progress.json`；写 `structure.progress.json` |
| `finalize`       | `artifacts.finalize`       | 时间戳对齐 + 合成最终课程包（`finalizeCourse`），发 `aligning` → `done`                                                                     | 读 `meta.json` / `transcript.json`；写 `course.json` / `alignment.json`        |

要点：

- **`reviewGate` 必须是纯节点**。LangGraph 在 resume 时会从「调用 `interrupt` 的那个节点
  开头」重放，如果它里面调 LLM 或写文件，就会重复计费/重复落盘。所以它只读进度 + interrupt，
  真正的重跑放在 `retryBatch`。
- `structureBatch` 和 `retryBatch` 都是「一句一次调用」的批处理，区别只是后者带一个
  `indexes` 白名单（只重跑指定句）。
- `prepare` 只在前半段（fresh 跑）出现；resolve 阶段由 checkpoint 还原 state，直接从
  `reviewGate` 继续，不会重跑前三个节点。

### interrupt / resume 载荷

`reviewGate` 的 `interrupt()` 载荷（`ReviewInterruptPayload`，仅作日志用途，前端实际读
`structure.progress.json`）：

```json
{ "failureCount": 2, "failureIndexes": [3, 7], "outDir": "…", "round": 0 }
```

恢复时传 `new Command({ resume: { decisions: [...] } })`，`decisions` 是
`ResolveDecision[]`（`{ index, action: "delete" | "retry" }`）。校验规则
（`validateResolveDecisions`）：

- `index` 必须是失败清单里的整数，否则抛「无效决策」；
- `action` 只能是 `delete` / `retry`；
- 同一 `index` 不能重复；
- **每个失败句都必须有决策**，缺一个就抛「缺少对失败句的决策」。

---

## 3. 分叉边的判断条件

### 3.1 `structureBatch → reviewGate | finalize`

```ts
(state) => (state.failureCount > 0 ? "reviewGate" : "finalize");
```

判定源是 `failureCount`，由 `structureBatch` 的返回值写入：`generateDraftCollected` 返回的
`failures.length`。注意：

- 只有**失败句数 > 0** 才进人工；全部成功直接 `finalize`，全自动跑完；
- 失败时 `structureBatch` 已经把 `chains`（成功部分）和 `structure.progress.json` 写好了，
  所以即使 `reviewGate` 抛错/中断，产物也是完整的、可恢复的。

### 3.2 `retryBatch → reviewGate | finalize`

```ts
(state) => (state.failureCount > 0 ? "reviewGate" : "finalize");
```

同一个判定函数，但 `failureCount` 的含义变了：它现在是**本轮重试后仍未通过的句数**
（`newFailures`，不是历史累计）。

- `> 0`：回到 `reviewGate` 再次暂停，让前端做第 2、3 轮决策；
- `= 0`：进 `finalize`。

**为什么「仍有失败」回 `reviewGate` 而不是直接结束**：要让 checkpoint 始终停在
pending interrupt 上。这样前端第 2、3 轮 resolve 依然能用 `thread_id` 续跑，不必降级 legacy。

回到 `reviewGate` 时还有一个隐式闸门：

```ts
if (state.round >= MAX_REVIEW_ROUNDS) throw new Error("[forge] 已连续 N 轮仍有 … 句未通过校验");
```

`MAX_REVIEW_ROUNDS = 3`（`artifacts.ts`）。`round` 在 `reviewGate` resume 成功时 `+1`，
所以最多允许 3 轮人工决策；第 4 次进入直接抛错，防止前端反复重试把图跑成死循环。

### 3.3 `retryBatch` 内部的「非边」分支

虽然没有对应的条件边，但这两处会**改变走向**，读代码时容易漏：

- **全部删光**：合并后 `merged.every(c => c.statements.length === 0)` → 抛
  「处理后没有任何句子，无法生成课程」（不进 `finalize`，避免产出空课程）；
- **没有任何 retry 句**（全是 delete）：跳过 `generateDraftCollected`，直接把保留句合并；
  若此时 `failures` 为空就正常进 `finalize`。

---

## 4. state 与「大对象不进 state」

`state.ts` 里 `ForgeState` 的 channel 全部是**覆盖式** reducer（`(_prev, next) => next`）：

| 字段                              | 含义                                                                  | 谁写                                         |
| --------------------------------- | --------------------------------------------------------------------- | -------------------------------------------- |
| `jobId`                           | 与 `thread_id` 相同，仅日志/交叉校验                                  | 入口                                         |
| `outDir`                          | 产物绝对路径，所有磁盘 IO 的根                                        | `prepare`                                    |
| `params`                          | `mediaPath` / `title` / `description` / `type` / `language` / `clips` | 入口 + `prepare` 回写 clips                  |
| `stage`                           | 当前阶段（`transcoding` … `done`）                                    | 各节点                                       |
| `transcriptStat`                  | 转写摘要（段数 / 是否词级 / 切片数）                                  | `transcribe`                                 |
| `chains`                          | 结构化产物 `DraftChain[]`                                             | `structureBatch` / `retryBatch` / `finalize` |
| `failureCount` / `failureIndexes` | 失败句数与下标（边判定用）                                            | `structureBatch` / `retryBatch`              |
| `round`                           | 已进入 `reviewGate` 的轮次                                            | `reviewGate`                                 |
| `decisions`                       | 前端决策，来自 `Command({resume})`                                    | `reviewGate`                                 |
| `statementCount` / `alignRate`    | 收尾统计                                                              | `structureBatch` / `finalize`                |

两条约定：

1. **transcript 和失败明细（含模型原始输出）不进 state**，只留磁盘，节点内按需 `readJson`。
   否则 checkpoint 会被复制多份、随产物上传而膨胀。
2. **`chains` 用覆盖而不是按 index 合并**：resolve 轮次要能「删掉」某些句，合并式 reducer
   无法表达删除（被删的 index 会从上一版里留下来）。

---

## 5. 文件分工

| 文件                   | 职责                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| `build.ts`             | 拓扑：`addNode` / `addEdge` / `addConditionalEdges`，导出 `GRAPH_VERSION` 与可移植的类型别名         |
| `nodes.ts`             | 节点薄封装：只负责「调 artifacts + 决定返回哪个 state 更新」；`reviewGate` 是纯节点                  |
| `artifacts.ts`         | 节点的磁盘/LLM 实现面（`ForgeArtifactSource` 接口 + `ForgeArtifacts` 实现 + `MAX_REVIEW_ROUNDS`）    |
| `state.ts`             | `ForgeState` channel 定义与 `ForgeParams` / `TranscriptStat` 类型                                    |
| `events.ts`            | 阶段事件发射器：单调序号过滤，映射成 stdout `{event:"stage"}` JSON Lines                             |
| `run.ts`               | 阶段入口（`transcribe` / `structure` / `structure-resolve`）：组 config/Command、判终态、`canResume` |
| `file-checkpointer.ts` | 单文件 checkpointer（`outDir/graph.checkpoint.json`），带 `threadId` / `graphVersion` 校验           |
| `dev-entry.ts`         | LangGraph Studio 调试入口（`MemorySaver`，不参与生产）                                               |

---

## 6. checkpoint 与降级

- checkpoint 落在 `outDir/graph.checkpoint.json`，**单文件**（而非目录）是为了配合
  `ForgeService.ARTIFACT_FILES` 的顶层文件名白名单，上传对象存储时只需加一项。
- `GRAPH_VERSION`（`build.ts`）在节点/边发生结构变化时 +1；旧 checkpoint 会被判为不可用。
- `run.ts` 的 `canResume` 四个条件全满足才续跑：文件存在 + `threadId` 一致 +
  `graphVersion` 一致 + `state.next` 包含 `reviewGate`。任一不满足返回 `unavailable`，
  由 `pipeline-runner` 降级 legacy（旧任务本来就没 checkpoint 文件，天然走这条路）。
- 阶段事件用闭包注入的 `StageEmitter`，而不是靠 `graph.stream({streamMode:"updates"})` 反推：
  `transcribe` 一个节点内要先后发 `transcoding` → `transcribing`，节点级更新表达不了。

---

## 7. 调试

```bash
# 完整跑（真实 ffmpeg / ASR / LLM，会读 apps/api/.env）
pnpm dev:langsmith
```

Studio 的 Input 给一条最小 state：

```json
{
  "jobId": "studio-dev",
  "outDir": "D:/tmp/forge-studio",
  "params": {
    "mediaPath": "D:/tmp/demo.mp4",
    "title": "Studio 调试",
    "type": "dialogue",
    "language": "en"
  }
}
```

只想看拓扑与中断行为：把模型配成不可用，得到失败句后在 `reviewGate` 的 interrupt 上
用 Studio 的 "Resume" 提交：

```json
{ "decisions": [{ "index": 0, "action": "delete" }] }
```

单测见 `../tests/graph/build.spec.ts`（注入假 artifacts，覆盖正常流、中断/恢复、多轮上限、
决策校验）。

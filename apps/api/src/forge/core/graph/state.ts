/**
 * Forge 图的状态定义。
 *
 * 取舍：**大对象不进 state**。transcript（可能几百段 × 每段几十个词）与失败明细
 * （含模型原始输出）都留在磁盘上，节点内按需 readJson；state 里只放控制流与摘要，
 * 避免 checkpoint 被复制多份后随产物上传膨胀。
 *
 * ## Studio 的「必填」从哪来（改这块前必读）
 *
 * Studio 的 Input 面板渲染的是 langgraph-api 吐给它的 JSON Schema
 * （`GET /assistants/:id/schemas` → `input_schema`），而获取顺序是：
 *
 *   1. 运行时 schema（zod / `StateSchema`）—— **优先**；
 *   2. 拿不到才退回**静态解析 TS 类型**（`getStaticGraphSchema`）。
 *
 * 坑在 ②：静态解析里 ts-json-schema-generator 的 `required` 选项被写死成 `false`
 * （`buildGenerator(program)` 走默认参数），所以 `Annotation.Root` 定义的 state
 * **在 Studio 里所有字段永远是 optional**，把 TS 里的 `?` 去掉也没用。
 *
 * 因此这里双管齐下：
 *   - state 仍用 `Annotation`（default / 覆盖语义最直观，节点读到的都是完整值）；
 *   - 另给一份 zod 的 `ForgeInputSchema` 作为图的 **input** 挂到 `StateGraph` 上
 *     （见 `build.ts`），Studio 与 `invoke` 校验都以它为准 —— zod 里没 `.optional()`
 *     的字段就是必填，`mediaPath` / `title` 因此会显示为必填。
 */
import type { AnnotationRoot, BaseChannel, OverwriteValue } from "@langchain/langgraph";

import { Annotation } from "@langchain/langgraph";
import { z } from "zod";

import type { ClipRange, DraftChain, ForgeStage, ResolveDecision } from "../types";

/**
 * ASR 语言白名单。
 *
 * 与前端 `ClipUploadForm` 的 select、`CreateForgeJobDto` 的 `@IsIn(["en","zh","ja"])`
 * 保持一致；写成 `as const` 是为了让 zod 产出真正的 JSON Schema `enum`，
 * Studio 的 Input 面板才会把它渲染成下拉框（与 `type` 一样），而不是让用户手填一个
 * 可能拼错、直到 ASR 阶段才暴露的语言代码。
 */
export const FORGE_LANGUAGES = ["en", "zh", "ja"] as const;
export type ForgeLanguage = (typeof FORGE_LANGUAGES)[number];

/** 运行时白名单校验（环境变量 / 旧 checkpoint 这类「字符串来自外部」的边界用） */
export function isForgeLanguage(value: string): value is ForgeLanguage {
  return (FORGE_LANGUAGES as readonly string[]).includes(value);
}

/**
 * fresh（transcribe）阶段的入参（**入口与 state 的类型来源**）。
 *
 * `mediaPath` / `title` 是 `prepare` 写 `meta.json` 的必需品，缺了必然启动即失败，
 * 所以是必填；`ForgeInputSchema` 里与它们一一对应且**没有 `.optional()`**，
 * 那才是 Studio 表单的 `required` 来源。
 */
export interface ForgeParams {
  /** 源媒体绝对路径（ffmpeg / ASR 读本地文件，必须真实存在） */
  mediaPath: string;
  /** 课程包标题，写进 meta.json */
  title: string;
  description?: string;
  type: "dialogue" | "music";
  /** ASR 语言提示；只接受 `FORGE_LANGUAGES` 里的值（Studio 下拉框同源） */
  language: ForgeLanguage;
  /** 已规整（排序 / 越界裁剪）后的切片区间；缺省转写整段 */
  clips?: ClipRange[];
}

/**
 * `ForgeParams` 的 zod 镜像：只用来产出 Studio 读的 JSON Schema 与 invoke 入参校验。
 * 字段与上面的 interface 必须保持一致（改一边记得改另一边）。
 */
export const ForgeParamsSchema = z.object({
  mediaPath: z.string().describe("源媒体绝对路径（ffmpeg / ASR 读本地文件，必须真实存在）"),
  title: z.string().describe("课程包标题，写进 meta.json"),
  description: z.string().optional(),
  type: z.enum(["dialogue", "music"]),
  // 必须是 enum（而不是 z.string()），否则 Studio 给的是自由输入框
  language: z.enum(FORGE_LANGUAGES).describe("ASR 语言：en 英语 / zh 中文 / ja 日语"),
  clips: z
    .array(z.object({ start: z.number(), end: z.number() }))
    .optional()
    .describe("已规整（排序 / 越界裁剪）后的切片区间；缺省转写整段"),
});

/**
 * 图的**输入** schema（fresh 阶段）。
 *
 * - 挂了它之后，`graph.invoke` 会按它校验入参（少传 `params` 直接报 Required），
 *   Studio 的 Input 面板也按它渲染必填标记 —— 比等到 `prepare` 才抛错早一步；
 * - `structure-resolve` 阶段走 `Command({resume})`，不经过这里。
 *
 * **只有 `params` 是必填**。`jobId` / `outDir` 在这里是 `.optional()`，不是偷懒：
 *   - `jobId` 只用于日志与 checkpoint 归属校验，Studio 里由平台按 thread_id 管，
 *     图内部节点根本不读它（见 `run.ts` 的 `buildRunConfig`），缺了不影响执行；
 *   - `outDir` 缺省时由 `prepareRun` 回落到 `config.defaultOutRoot`，本来就有默认值。
 * 把这两个标成 required 只会让 Studio 的表单无谓地卡住，用户还得手填一个
 * 平台已经知道的值。真正会让流水线「启动即失败」的只有 `params.mediaPath` / `title`。
 *
 * 注意：`ForgeInputSchema` 只约束**入口**。`state` 侧（`ForgeState`）仍保留
 * 各自的 default，两条路径互补 —— 类型检查管代码调用，这份 schema 管 JSON 调用。
 */
export const ForgeInputSchema = z.object({
  jobId: z
    .string()
    .optional()
    .describe("与 thread_id 相同，仅用于日志与交叉校验；省略则留在 state 的空串默认值"),
  outDir: z
    .string()
    .optional()
    .describe("产物目录绝对路径；省略或为空时回落到 config.defaultOutRoot/<runId>"),
  params: ForgeParamsSchema,
});

// `Annotation<T>({ reducer })` 实际返回的 channel 形态。
//
// 显式写出 channel 表而不是依赖 `Annotation.Root` 的推断：推断类型会指向
// `@langchain/langgraph` 内部的 `BaseChannel`（该包有 index / web 两个类型入口，
// 不同 tsconfig 会解析到不同文件），开启 `declaration` 后 TS 无法稳定命名它，
// 报 TS2742「cannot be named without a reference to ... BaseChannel」。显式注解可消除。
type ValueChannel<T> = BaseChannel<T, T | OverwriteValue<T>, unknown>;

type ForgeChannels = {
  jobId: ValueChannel<string>;
  outDir: ValueChannel<string>;
  params: ValueChannel<ForgeParams>;
  stage: ValueChannel<ForgeStage>;
  chains: ValueChannel<DraftChain[]>;
  failureCount: ValueChannel<number>;
  failureIndexes: ValueChannel<number[]>;
  round: ValueChannel<number>;
  decisions: ValueChannel<ResolveDecision[] | null>;
  statementCount: ValueChannel<number>;
  alignRate: ValueChannel<number>;
  needsFix: ValueChannel<boolean>;
};

export const ForgeState: AnnotationRoot<ForgeChannels> = Annotation.Root({
  /** 与 thread_id 相同，仅用于日志与交叉校验 */
  jobId: Annotation<string>({ reducer: (_prev, next) => next, default: () => "" }),
  /** 产物目录（绝对路径）：节点所有磁盘 IO 的根 */
  outDir: Annotation<string>({ reducer: (_prev, next) => next, default: () => "" }),
  /**
   * 入参。`ForgeInputSchema` 已在 invoke 处校验必填；这里的 default 只是兜底
   * （resolve 阶段从旧 checkpoint 还原时可能残缺），由 `prepare` / `transcribe` 的守卫报错。
   */
  params: Annotation<ForgeParams>({
    reducer: (_prev, next) => next,
    default: () => ({ mediaPath: "", title: "", type: "dialogue", language: "en" }),
  }),
  stage: Annotation<ForgeStage>({ reducer: (_prev, next) => next, default: () => "transcoding" }),
  /**
   * 结构化产物。**用覆盖而不是按 index 合并**：resolve 轮次需要能「删掉」某些句，
   * 合并式 reducer 无法表达删除（被删的 index 会从上一版里留下来）。
   */
  chains: Annotation<DraftChain[]>({ reducer: (_prev, next) => next, default: () => [] }),
  failureCount: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
  failureIndexes: Annotation<number[]>({ reducer: (_prev, next) => next, default: () => [] }),
  /** 已进入 reviewGate 的轮次：防止用户反复重试导致无限循环 */
  round: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
  /** 前端对失败句的决策（来自 Command({resume})） */
  decisions: Annotation<ResolveDecision[] | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  statementCount: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
  alignRate: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
  needsFix: Annotation<boolean>({ reducer: (_prev, next) => next, default: () => false }),
});

export type ForgeStateType = typeof ForgeState.State;
export type ForgeStateUpdate = Partial<ForgeStateType>;

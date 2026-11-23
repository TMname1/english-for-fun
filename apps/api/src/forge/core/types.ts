/** ASR 原始返回的词 */
export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

/** 用户选中的视频时间区间（秒，相对原视频绝对时间） */
export interface ClipRange {
  start: number;
  end: number;
}

/** ASR 段（utterance） */
export interface TranscriptSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  words?: TranscriptWord[];
  /** 所属 clip 序号；仅切片转写流程存在，用于禁止跨 clip 拼句 */
  clipIndex?: number;
}

export interface Transcript {
  /** 是否有词级时间戳；false 时为段级降级模式 */
  wordLevel: boolean;
  language: string;
  segments: TranscriptSegment[];
}

/** LLM 结构化产物里的句子（时间戳由 align 步骤回填） */
export interface DraftStatement {
  english: string;
  chinese: string;
  phonetic?: string;
  /** 配套视频中的起点（秒）；对齐失败时缺省 */
  startTime?: number | null;
  /** 配套视频中的终点（秒）；对齐失败时缺省 */
  endTime?: number | null;
  /** 逐词时间戳；ASR 段级降级时为 null */
  words?: { word: string; start: number; end: number }[] | null;
}

/** 一行 statement 在转写词序列中的跨度（全局 ref 下标、半开区间），由编号直算 */
export interface StatementSpan {
  wordStart: number;
  wordEnd: number;
}

/**
 * 一句 LLM 结构化产物：statements 与其等长的词编号跨度。
 * spans 用于对齐阶段直接取时间戳；旧进度快照 / 降级场景为 null。
 */
export interface DraftChain {
  /** transcript.segments 原数组下标 */
  index: number;
  statements: DraftStatement[];
  spans?: (StatementSpan | null)[];
}

/** 单次结构化尝试的失败快照：reason 为校验失败原因，statements/raw 用于前端展示模型输出 */
export interface SentenceAttempt {
  reason: string;
  statements?: DraftStatement[] | null;
  raw?: string | null;
}

/** 一个句子在全部尝试后仍失败的「可恢复」失败记录 */
export interface SentenceFailure {
  /** 在 transcript.segments 中的原数组下标 */
  index: number;
  /** 要求的完整原句 */
  sentence: string;
  attempts: SentenceAttempt[];
}

/** 结构化进度快照：成功链 + 失败清单，用于 needs_fix 后的 resolve 续跑 */
export interface StructureProgress {
  success: Array<{ index: number; statements: DraftStatement[]; spans?: (StatementSpan | null)[] }>;
  failures: SentenceFailure[];
}

/** 前端对每个失败句的选择：删除该句 / 重试该句 / 删除该句输出里的所有单词行 */
export interface ResolveDecision {
  index: number;
  action: "delete" | "retry" | "strip_words";
}

/** 最终课程包 JSON（文本课程；音频字段由后续流程填充，流水线不产出） */
export interface ForgeCourse {
  title: string;
  description?: string;
  statements: DraftStatement[];
}

export interface ForgePayload {
  title: string;
  description: string;
  cover: string;
  /** 单一课程对象（不再是数组）：title/description 为校对文案，入库的只有 statements */
  courses: ForgeCourse;
}

/** forge make 的运行元数据 */
export interface ForgeMeta {
  runId: string;
  title: string;
  description: string;
  type: "dialogue" | "music";
  audioPath: string;
  /** 输入为视频时记录原始视频路径（audioPath 与其相同） */
  videoPath?: string;
  createdAt: string;
}

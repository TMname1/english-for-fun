/** ASR 原始返回的词 */
export interface TranscriptWord {
  word: string;
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

/**
 * LLM 单次调用产出的单一课程。
 * "分课程"功能已删除：一个课程包只有一门课程，长音频分块产出的 statements 会合并进这一门课。
 */
export interface DraftCourse {
  title: string;
  description?: string;
  statements: DraftStatement[];
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

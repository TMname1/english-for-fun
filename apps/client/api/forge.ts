import type { $Fetch } from "ofetch";

import { useRuntimeConfig } from "#imports";
import { ofetch } from "ofetch";

export interface ForgeJobCourseStatement {
  english: string;
  chinese: string;
  phonetic?: string;
  startTime?: number | null;
  endTime?: number | null;
  words?: { word: string; start: number; end: number }[] | null;
}

export interface ForgeJobCourseJson {
  title: string;
  description: string;
  cover: string;
  courses: {
    title: string;
    description?: string;
    statements: ForgeJobCourseStatement[];
  };
}

/** ASR 转录的单个词：word 文字可校对，start/end 只读 */
export interface ForgeTranscriptWord {
  word: string;
  start: number;
  end: number;
}

/** ASR 转录分段：删过的段不出现；text 由 words 派生（只读展示） */
export interface ForgeTranscriptSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  words?: ForgeTranscriptWord[] | null;
}

export interface ForgeTranscript {
  wordLevel: boolean;
  language: string;
  segments: ForgeTranscriptSegment[];
}

/** 单次结构化尝试的失败快照 */
export interface ForgeSentenceAttempt {
  reason: string;
  statements?: ForgeJobCourseStatement[] | null;
  raw?: string | null;
  /** 该快照来自后端「逐词成行」的自动删单词补救（已自动处理过），前端不再重复提供该操作 */
  autoStrip?: boolean;
}

/** 一个句子在全部尝试后仍失败的记录 */
export interface ForgeStructureFailure {
  index: number;
  sentence: string;
  attempts: ForgeSentenceAttempt[];
}

/** 结构化进度快照：成功链 + 失败清单（needs_fix 状态返回） */
export interface ForgeStructureProgress {
  success: Array<{ index: number; statements: ForgeJobCourseStatement[] }>;
  failures: ForgeStructureFailure[];
}

/** 前端对每个失败句的选择：删除该句 / 重试该句（输出混着单词行由后端自动补救） */
export interface ResolveForgeFailuresDecision {
  index: number;
  action: "delete" | "retry";
}

/** 校对续跑时回传的分段（被删除的段不包含） */
export interface ResumeTranscriptSegment {
  id: number;
  start: number;
  end: number;
  text?: string;
  words: ForgeTranscriptWord[];
}

export type ForgeJobStatusValue =
  | "pending"
  | "running"
  | "awaiting_review"
  | "needs_fix"
  | "done"
  | "failed"
  | "cancelled";

export type ForgeJobStageValue =
  | "pending"
  | "transcoding"
  | "transcribing"
  | "transcribed"
  | "structuring"
  | "aligning"
  | "done";

export interface ForgeJobView {
  id: string;
  status: ForgeJobStatusValue;
  stage: ForgeJobStageValue;
  message: string;
  error?: string;
  elapsedMs: number;
  outDir: string;
  /** 媒体预签名 URL（对象存储直连，会过期），仅供预览播放 */
  videoPath: string;
  /** 媒体对象键（视频或音频），入库时填到 course_packs.video */
  videoKey: string;
  /** 媒体类型：audio 时剪辑页只渲染音频播放条 */
  mediaKind?: "video" | "audio";
  title: string;
  type: "dialogue" | "music";
  language?: string;
  description?: string;
  /** status=awaiting_review 时附带：ASR 转录结果，供 word 级校对 */
  transcriptJson?: ForgeTranscript;
  courseJson?: ForgeJobCourseJson;
  /** status=needs_fix 时附带：结构化成功链 + 失败清单 */
  structureProgress?: ForgeStructureProgress;
  /** 视频切片流程：选中的时间区间（秒） */
  clips?: { start: number; end: number }[];
}

export interface UploadForgeJobParams {
  file: File;
  title: string;
  type: "dialogue" | "music";
  desc?: string;
  language?: string;
  /** true 时只上传不启动流水线，之后用 startForgeJob 提交切点 */
  defer?: boolean;
}

/**
 * 单独走 ofetch：
 * 1. 让浏览器自设 multipart boundary（共享 http 实例默认 Content-Type: application/json）
 * 2. 轮询期间不希望触发全局 onResponseError 的 toast 噪音
 */
function forgeFetch(): $Fetch {
  const config = useRuntimeConfig();
  return ofetch.create({ baseURL: config.public.apiBase as string, credentials: "include" });
}

export async function uploadForgeJob(params: UploadForgeJobParams): Promise<{ jobId: string }> {
  const formData = new FormData();
  formData.append("videoFile", params.file);
  formData.append("title", params.title);
  formData.append("type", params.type);
  if (params.desc) formData.append("desc", params.desc);
  if (params.language) formData.append("language", params.language);
  if (params.defer) formData.append("defer", "true");
  const $fetch = forgeFetch();
  return await $fetch<{ jobId: string }>("/forge/jobs", { method: "post", body: formData });
}

/** 视频切片流程：defer 上传后提交选中区间并启动转写；clips 缺省转写整段 */
export async function startForgeJob(
  jobId: string,
  clips?: { start: number; end: number }[],
): Promise<{ jobId: string }> {
  const $fetch = forgeFetch();
  return await $fetch<{ jobId: string }>(`/forge/jobs/${jobId}/start`, {
    method: "post",
    body: { clips },
    retry: 0,
  });
}

export async function fetchForgeJob(jobId: string): Promise<ForgeJobView> {
  const $fetch = forgeFetch();
  return await $fetch<ForgeJobView>(`/forge/jobs/${jobId}`, { method: "get", retry: 0 });
}

export async function cancelForgeJob(jobId: string): Promise<{ cancelled: boolean }> {
  const $fetch = forgeFetch();
  return await $fetch<{ cancelled: boolean }>(`/forge/jobs/${jobId}`, {
    method: "delete",
    retry: 0,
  });
}

/** 校对完成后续跑：提交 word 级编辑结果，后端继续结构化 + 对齐 */
export async function resumeForgeJob(
  jobId: string,
  segments: ResumeTranscriptSegment[],
): Promise<{ jobId: string }> {
  const $fetch = forgeFetch();
  return await $fetch<{ jobId: string }>(`/forge/jobs/${jobId}/resume`, {
    method: "post",
    body: { segments },
    retry: 0,
  });
}

/** 结构化失败句处理后：对每个失败句提交 delete/retry 决策并续跑 */
export async function resolveForgeJob(
  jobId: string,
  decisions: ResolveForgeFailuresDecision[],
): Promise<{ jobId: string }> {
  const $fetch = forgeFetch();
  return await $fetch<{ jobId: string }>(`/forge/jobs/${jobId}/resolve`, {
    method: "post",
    body: { decisions },
    retry: 0,
  });
}

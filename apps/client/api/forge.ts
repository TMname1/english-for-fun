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
  /** 视频在服务器静态目录的站内 URL，如 /course-video/xxx.mp4 */
  videoPath: string;
  title: string;
  type: "dialogue" | "music";
  language?: string;
  description?: string;
  /** status=awaiting_review 时附带：ASR 转录结果，供 word 级校对 */
  transcriptJson?: ForgeTranscript;
  courseJson?: ForgeJobCourseJson;
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

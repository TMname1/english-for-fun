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

export type ForgeJobStatusValue = "pending" | "running" | "done" | "failed" | "cancelled";

export type ForgeJobStageValue =
  | "pending"
  | "transcoding"
  | "transcribing"
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
  courseJson?: ForgeJobCourseJson;
}

export interface UploadForgeJobParams {
  file: File;
  title: string;
  type: "dialogue" | "music";
  desc?: string;
  language?: string;
}

/**
 * 单独走 ofetch：
 * 1. 让浏览器自设 multipart boundary（共享 http 实例默认 Content-Type: application/json）
 * 2. 轮询期间不希望触发全局 onResponseError 的 toast 噪音
 */
function forgeFetch(): $Fetch {
  const config = useRuntimeConfig();
  return ofetch.create({ baseURL: config.public.apiBase as string });
}

export async function uploadForgeJob(params: UploadForgeJobParams): Promise<{ jobId: string }> {
  const formData = new FormData();
  formData.append("videoFile", params.file);
  formData.append("title", params.title);
  formData.append("type", params.type);
  if (params.desc) formData.append("desc", params.desc);
  if (params.language) formData.append("language", params.language);
  const $fetch = forgeFetch();
  return await $fetch<{ jobId: string }>("/forge/jobs", { method: "post", body: formData });
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

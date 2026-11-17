import type { $Fetch } from "ofetch";

import { useRuntimeConfig } from "#imports";
import { ofetch } from "ofetch";

import type { CoursePack, CoursePackLearning, CoursePacksItem } from "~/types";
import { getHttp } from "./http";

export type CoursePacksItemApiResponse = {
  id: string;
  title: string;
  description: string;
  cover: string;
};

export interface StatementWordApiResponse {
  word: string;
  start: number;
  end: number;
}

export interface StatementApiResponse {
  order: number;
  chinese: string;
  english: string;
  soundmark: string;
  /** 配套视频中的起点/终点（秒）；有值且课程包带 video 时走视频 seek 播放 */
  startTime?: number | null;
  endTime?: number | null;
  /** 逐词时间戳；为空时单词播放回退 TTS */
  words?: StatementWordApiResponse[] | null;
  /** 客户端依据已掌握元素标记，非服务端字段 */
  isMastered?: boolean;
}

export interface CoursePackApiResponse {
  id: string;
  title: string;
  description: string;
  cover: string;
  completionCount: number;
}

export interface CoursePackLearningApiResponse {
  id: string;
  title: string;
  description: string;
  video: string;
  statements: StatementApiResponse[];
  statementIndex: number;
}

export async function fetchCoursePacks() {
  const http = getHttp();
  return (await http<CoursePacksItemApiResponse[]>("/course-pack", {
    method: "get",
  })) as CoursePacksItem[];
}

export async function fetchCoursePack(coursePackId: string) {
  const http = getHttp();
  return (await http<CoursePackApiResponse>(`/course-pack/${coursePackId}`, {
    method: "get",
  })) as CoursePack;
}

/**
 * 课程包学习内容：包内唯一课程的 statements + 用户进度。
 * "分课程"功能已删除：不再按 courseId 获取课程。
 */
export async function fetchCoursePackLearning(coursePackId: string) {
  const http = getHttp();
  const body = await http<CoursePackLearningApiResponse>(`course-pack/${coursePackId}/learning`, {
    method: "get",
  });

  return {
    coursePackId: body.id,
    title: body.title,
    description: body.description ?? "",
    video: body.video ?? "",
    statements: body.statements,
    statementIndex: body.statementIndex ?? 0,
  } as CoursePackLearning;
}

/** 完成一次课程包学习（累计 completionCount） */
export async function fetchCompleteCoursePack(coursePackId: string) {
  const http = getHttp();
  return await http<void>(`/course-pack/${coursePackId}/complete`, { method: "post" });
}

export interface CreateCoursePackStatement {
  english: string;
  chinese: string;
  phonetic: string;
  /** 配套视频起点（秒），与 endTime 一起决定视频 seek 播放 */
  startTime?: number;
  /** 配套视频终点（秒） */
  endTime?: number;
  /** 逐词时间戳；缺失时单词播放回退 TTS */
  words?: { word: string; start: number; end: number }[];
}

/** 单一课程对象（原 courses 数组已随"分课程"功能删除）；title/description 可选 */
export interface CreateCoursePackCourse {
  title?: string;
  description?: string;
  statements: CreateCoursePackStatement[];
}

export interface CreateCoursePackPayload {
  title: string;
  description: string;
  cover: string;
  /** 配套视频站内路径（/course-video/xxx.mp4）或外部 URL */
  video?: string;
  courses: CreateCoursePackCourse;
}

export interface CreateCoursePackResponse {
  coursePackId: string;
}

export async function createCoursePack(payload: CreateCoursePackPayload) {
  const http = getHttp();
  return await http<CreateCoursePackResponse>("/course-pack", {
    method: "post",
    body: payload,
  });
}

export interface DeleteCoursePackResponse {
  deleted: boolean;
  coursePackId: string;
}

export async function deleteCoursePack(coursePackId: string) {
  const http = getHttp();
  return await http<DeleteCoursePackResponse>(`/course-pack/${coursePackId}`, {
    method: "delete",
  });
}

/** 「修改课程」表单预填数据：课程包元信息（含 video）+ 句子（含 startTime/endTime） */
export interface CoursePackEditData {
  title: string;
  description: string;
  cover: string;
  video: string;
  statements: CreateCoursePackStatement[];
}

export async function fetchCoursePackForEdit(coursePackId: string) {
  const http = getHttp();
  return await http<CoursePackEditData>(`/course-pack/${coursePackId}/edit`, {
    method: "get",
  });
}

export interface UpdateCoursePackResponse {
  coursePackId: string;
}

/** 修改课程包：复用创建时的 payload 结构（title/description/cover + courses.statements） */
export async function updateCoursePack(coursePackId: string, payload: CreateCoursePackPayload) {
  const http = getHttp();
  return await http<UpdateCoursePackResponse>(`/course-pack/${coursePackId}`, {
    method: "patch",
    body: payload,
  });
}

/**
 * 上传本地视频文件到 /course-video 静态目录，返回站内路径。
 * 单独走 ofetch：让浏览器自设 multipart boundary（共享 http 实例默认 application/json 会破坏上传）。
 */
function coursePackFetch(): $Fetch {
  const config = useRuntimeConfig();
  return ofetch.create({ baseURL: config.public.apiBase as string, credentials: "include" });
}

export async function uploadCoursePackVideo(file: File): Promise<{ video: string }> {
  const formData = new FormData();
  formData.append("videoFile", file);
  const $fetch = coursePackFetch();
  return await $fetch<{ video: string }>("/course-pack/video", {
    method: "post",
    body: formData,
    retry: 0,
  });
}

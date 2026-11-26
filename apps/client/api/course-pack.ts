import type { CoursePack, CoursePackLearning, CoursePacksItem } from "~/types";
import {
  assertUploadable,
  mediaFetch,
  putFileToOss,
  requestUploadTicket,
} from "~/api/media-upload";
import { resolveMediaKind } from "~/utils/media";
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
  /** 对象存储预签名 URL（会过期）或外部 URL */
  video: string;
  /** true = 外部链接（走外链图标）；false = 对象存储媒体（页内播放器 seek） */
  videoIsExternal?: boolean;
  /** 媒体类型（服务端按扩展名派生）：audio 时页内只渲染音频播放条 */
  mediaKind?: "video" | "audio";
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
    videoIsExternal: body.videoIsExternal ?? false,
    mediaKind: resolveMediaKind(body.mediaKind, body.video),
    statements: body.statements,
    statementIndex: body.statementIndex ?? 0,
  } as CoursePackLearning;
}

/** 课程目录筛选项（服务端筛选，跨页有效） */
export type StatementsFilter = "all" | "mastered" | "notMastered";

/** 目录里的一条句子：index 是在完整有序列表里的下标，跳句时直接用它 */
export interface StatementPageItemApiResponse extends StatementApiResponse {
  index: number;
  isMastered: boolean;
}

export interface StatementsPageApiResponse {
  items: StatementPageItemApiResponse[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * 课程目录分页：一次只取一页（服务端默认/最多 100 条）。
 * 句子很多时不要拉全量，按页请求。
 */
export async function fetchCoursePackStatements(
  coursePackId: string,
  params: { page?: number; pageSize?: number; filter?: StatementsFilter } = {},
) {
  const http = getHttp();
  return await http<StatementsPageApiResponse>(`/course-pack/${coursePackId}/statements`, {
    method: "get",
    query: params,
  });
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
  /** 配套视频对象键（course-video/xxx.mp4）或外部 URL */
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
 * 上传本地视频/音频文件到对象存储，返回对象键（入库用）、预签名预览 URL 与媒体类型。
 * 浏览器直传 OSS（见 ~/api/media-upload）：大文件不经服务器，避免 Cloudflare 100s 回源超时。
 */
export async function uploadCoursePackVideo(
  file: File,
  onProgress?: (percent: number) => void,
): Promise<{ video: string; videoUrl: string; mediaKind?: "video" | "audio" }> {
  assertUploadable(file);
  const ticket = await requestUploadTicket("/course-pack/video/presign", file.name);
  await putFileToOss(ticket, file, onProgress);

  const $fetch = mediaFetch();
  return await $fetch<{ video: string; videoUrl: string; mediaKind?: "video" | "audio" }>(
    "/course-pack/video/from-upload",
    {
      method: "post",
      body: { videoKey: ticket.key },
      retry: 0,
    },
  );
}

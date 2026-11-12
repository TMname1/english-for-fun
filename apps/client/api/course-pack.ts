import type { CoursePack, CoursePackLearning, CoursePacksItem } from "~/types";
import { getHttp } from "./http";

export type CoursePacksItemApiResponse = {
  id: string;
  title: string;
  description: string;
  cover: string;
};

export interface StatementApiResponse {
  order: number;
  chinese: string;
  english: string;
  soundmark: string;
  /** 真实音频切片路径（如 /course-audio/xxx.mp3）；为空时回退 TTS */
  audioUrl?: string | null;
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

/** 「修改课程」表单预填数据：课程包元信息 + 句子（规范成 english/chinese/phonetic） */
export interface CoursePackEditData {
  title: string;
  description: string;
  cover: string;
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

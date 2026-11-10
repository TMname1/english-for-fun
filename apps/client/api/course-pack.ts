import type { CourseApiResponse } from "./course";
import type { CoursePack, CoursePacksItem } from "~/types";
import { getHttp } from "./http";

export type CoursePacksItemApiResponse = {
  id: string;
  title: string;
  description: string;
  cover: string;
};

export interface CoursePackApiResponse {
  id: string;
  title: string;
  description: string;
  cover: string;
  courses: CourseApiResponse[];
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

export interface CreateCoursePackStatement {
  english: string;
  chinese: string;
  phonetic: string;
}

export interface CreateCoursePackCourse {
  title: string;
  description: string;
  statements: CreateCoursePackStatement[];
}

export interface CreateCoursePackPayload {
  title: string;
  description: string;
  cover: string;
  courses: CreateCoursePackCourse[];
}

export interface CreateCoursePackResponse {
  coursePackId: string;
  courseIds: string[];
}

export async function createCoursePack(payload: CreateCoursePackPayload) {
  const http = getHttp();
  return await http<CreateCoursePackResponse>("/course-pack", {
    method: "post",
    body: payload,
  });
}

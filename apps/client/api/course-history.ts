import type { CourseHistory } from "~/types";
import { getHttp } from "./http";

export interface CourseHistoryApiResponse {
  coursePackId: string;
  completionCount: number;
}

/**
 * 课程包学习记录（"分课程"功能删除后按包维度唯一一条；从未完成过时为 null）。
 */
export async function fetchCourseHistory(coursePackId: string) {
  const http = getHttp();
  return (await http<CourseHistoryApiResponse | null>(`/course-history/${coursePackId}`, {
    method: "get",
  })) as CourseHistory | null;
}

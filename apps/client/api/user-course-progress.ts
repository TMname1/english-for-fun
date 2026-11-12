import type { UserProgress, UserRecentCoursePack } from "~/types";
import { getHttp } from "./http";

export interface UserProgressApiResponse {
  coursePackId: string;
}
export interface UserRecentCoursePackApiResponse {
  id: number;
  coursePackId: string;
  title: string;
  description: string;
}

export interface UserProgressUpdate {
  coursePackId: string;
  statementIndex: number;
}

export async function fetchUpdateCourseProgress(userProgressUpdate: UserProgressUpdate) {
  const http = getHttp();
  return (await http<UserProgressApiResponse>(`user-course-progress`, {
    body: userProgressUpdate,
    method: "put",
  })) as UserProgress;
}

export async function fetchUserRecentCoursePacks() {
  const http = getHttp();
  return (await http<UserRecentCoursePackApiResponse[]>(
    `/user-course-progress/recent-course-packs`,
    {
      method: "get",
    },
  )) as UserRecentCoursePack[];
}

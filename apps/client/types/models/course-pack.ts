import type { StatementApiResponse } from "~/api/course-pack";

export type CoursePacksItem = {
  id: string;
  title: string;
  description: string;
  cover: string;
};

export interface Statement extends StatementApiResponse {}

/** 课程包详情（"分课程"功能删除后不再含 courses，completionCount 为包级学习次数） */
export type CoursePack = {
  id: string;
  title: string;
  description: string;
  cover: string;
  completionCount: number;
};

/** 课程包学习内容：包内唯一课程的 statements 与用户进度 */
export interface CoursePackLearning {
  coursePackId: string;
  title: string;
  description: string;
  /** 对象存储预签名 URL（会过期）或外部 URL */
  video: string;
  /** true = 外部链接；false = 对象存储视频（页内播放器 seek） */
  videoIsExternal?: boolean;
  statements: Statement[];
  statementIndex: number;
}

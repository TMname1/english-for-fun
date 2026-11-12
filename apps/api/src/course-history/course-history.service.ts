/**
 * 记录当前课程包每门课的学习次数
 */
import { Inject, Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";

import { courseHistory } from "@earthworm/schema";
import { DB, DbType } from "../global/providers/db.provider";

@Injectable()
export class CourseHistoryService {
  constructor(@Inject(DB) private db: DbType) {}

  async findAll() {
    return await this.db.query.courseHistory.findMany();
  }

  /** 课程包的学习记录（"分课程"功能删除后按课程包维度唯一一条） */
  async findByCoursePackId(coursePackId: string) {
    return await this.db.query.courseHistory.findFirst({
      columns: {
        id: true,
        coursePackId: true,
        completionCount: true,
      },
      where: eq(courseHistory.coursePackId, coursePackId),
    });
  }

  async findCompletionCount(coursePackId: string) {
    const record = await this.db.query.courseHistory.findFirst({
      where: eq(courseHistory.coursePackId, coursePackId),
    });

    return record ? record.completionCount : 0;
  }

  async upsert(coursePackId: string) {
    await this.db
      .insert(courseHistory)
      .values({
        coursePackId,
        completionCount: 1,
      })
      .onConflictDoUpdate({
        target: [courseHistory.coursePackId],
        set: { completionCount: sql`course_history.completion_count + 1` },
      });
  }
}

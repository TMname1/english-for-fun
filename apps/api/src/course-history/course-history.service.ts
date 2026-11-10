/**
 * 记录当前课程包每门课的学习次数
 */
import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";

import { courseHistory } from "@earthworm/schema";
import { DB, DbType } from "../global/providers/db.provider";

@Injectable()
export class CourseHistoryService {
  constructor(@Inject(DB) private db: DbType) {}

  async findAll() {
    return await this.db.query.courseHistory.findMany();
  }

  async findByCoursePackId(coursePackId: string) {
    return await this.db.query.courseHistory.findMany({
      columns: {
        id: true,
        coursePackId: true,
        courseId: true,
        completionCount: true,
      },
      where: eq(courseHistory.coursePackId, coursePackId),
    });
  }

  async findCompletionCount(coursePackId: string, courseId: string) {
    const record = await this.db.query.courseHistory.findFirst({
      where: and(
        eq(courseHistory.coursePackId, coursePackId),
        eq(courseHistory.courseId, courseId),
      ),
    });

    return record ? record.completionCount : 0;
  }

  async upsert(coursePackId: string, courseId: string) {
    await this.db
      .insert(courseHistory)
      .values({
        coursePackId,
        courseId,
        completionCount: 1,
      })
      .onConflictDoUpdate({
        target: [courseHistory.courseId, courseHistory.coursePackId],
        set: { completionCount: sql`course_history.completion_count + 1` },
      });
  }
}

import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";

import { coursePack, userCourseProgress } from "@earthworm/schema";
import { DB, DbType } from "../global/providers/db.provider";

@Injectable()
export class UserCourseProgressService {
  constructor(@Inject(DB) private db: DbType) {}

  async findStatement(coursePackId: string, courseId: string) {
    const result = await this.db.query.userCourseProgress.findFirst({
      where: and(
        eq(userCourseProgress.coursePackId, coursePackId),
        eq(userCourseProgress.courseId, courseId),
      ),
    });

    return result ? result.statementIndex : 0;
  }

  async getRecentCoursePacks(limit: number) {
    return await this.db
      .select({
        id: userCourseProgress.id,
        coursePackId: userCourseProgress.coursePackId,
        courseId: userCourseProgress.courseId,
        title: coursePack.title,
        description: coursePack.description,
        cover: coursePack.cover,
      })
      .from(userCourseProgress)
      .orderBy(desc(userCourseProgress.updatedAt))
      .limit(limit)
      .leftJoin(coursePack, eq(userCourseProgress.coursePackId, coursePack.id));
  }

  async upsert(coursePackId: string, courseId: string, statementIndex: number) {
    await this.db
      .insert(userCourseProgress)
      .values({
        coursePackId,
        courseId,
        statementIndex,
      })
      .onConflictDoUpdate({
        target: [userCourseProgress.coursePackId],
        set: { courseId, statementIndex },
      });
  }
}

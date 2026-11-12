import { Inject, Injectable } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";

import { coursePack, userCourseProgress } from "@earthworm/schema";
import { DB, DbType } from "../global/providers/db.provider";

@Injectable()
export class UserCourseProgressService {
  constructor(@Inject(DB) private db: DbType) {}

  async findStatement(coursePackId: string) {
    const result = await this.db.query.userCourseProgress.findFirst({
      where: eq(userCourseProgress.coursePackId, coursePackId),
    });

    return result ? result.statementIndex : 0;
  }

  async getRecentCoursePacks(limit: number) {
    return await this.db
      .select({
        id: userCourseProgress.id,
        coursePackId: userCourseProgress.coursePackId,
        title: coursePack.title,
        description: coursePack.description,
      })
      .from(userCourseProgress)
      .orderBy(desc(userCourseProgress.updatedAt))
      .limit(limit)
      .innerJoin(coursePack, eq(userCourseProgress.coursePackId, coursePack.id));
  }

  async upsert(coursePackId: string, statementIndex: number) {
    await this.db
      .insert(userCourseProgress)
      .values({
        coursePackId,
        statementIndex,
      })
      .onConflictDoUpdate({
        target: [userCourseProgress.coursePackId],
        set: { statementIndex },
      });
  }
}

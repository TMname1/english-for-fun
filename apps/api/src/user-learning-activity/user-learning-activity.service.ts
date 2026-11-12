import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gte, lte, sql, sum } from "drizzle-orm";

import { userLearningActivities as userLearningActivitiesSchema } from "@earthworm/schema";
import { DB, DbType } from "../global/providers/db.provider";

@Injectable()
export class UserLearningActivityService {
  constructor(@Inject(DB) private db: DbType) {}

  async upsertActivity(date: Date, activityType: string, duration: number, metadata?: any) {
    if (duration < 0) {
      throw new BadRequestException("Duration cannot be negative");
    }

    const dateStr = date.toISOString().split("T")[0];
    await this.db
      .insert(userLearningActivitiesSchema)
      .values({
        date: dateStr,
        activityType,
        duration,
        metadata,
      })
      .onConflictDoUpdate({
        target: [userLearningActivitiesSchema.date, userLearningActivitiesSchema.activityType],
        set: {
          duration: sql`${userLearningActivitiesSchema.duration} + ${duration}`,
          metadata: metadata
            ? sql`${userLearningActivitiesSchema.metadata} || ${JSON.stringify(metadata)}::jsonb`
            : undefined,
          updatedAt: new Date(),
        },
      });

    return true;
  }

  async getDailyTotalTime(activityType: string, startDate?: Date, endDate?: Date) {
    const conditions = [eq(userLearningActivitiesSchema.activityType, activityType)];

    if (startDate) {
      conditions.push(
        gte(userLearningActivitiesSchema.date, startDate.toISOString().split("T")[0]),
      );
    }
    if (endDate) {
      conditions.push(lte(userLearningActivitiesSchema.date, endDate.toISOString().split("T")[0]));
    }

    const result = await this.db
      .select({
        date: userLearningActivitiesSchema.date,
        totalDuration: sum(userLearningActivitiesSchema.duration),
      })
      .from(userLearningActivitiesSchema)
      .where(and(...conditions))
      .groupBy(userLearningActivitiesSchema.date)
      .orderBy(asc(userLearningActivitiesSchema.date));

    return result.map((item) => ({
      date: item.date,
      duration: Number(item.totalDuration) || 0,
    }));
  }

  async getTotalLearningTime(activityType: string, startDate?: Date, endDate?: Date) {
    const conditions = [eq(userLearningActivitiesSchema.activityType, activityType)];

    if (startDate) {
      conditions.push(
        gte(userLearningActivitiesSchema.date, startDate.toISOString().split("T")[0]),
      );
    }
    if (endDate) {
      conditions.push(lte(userLearningActivitiesSchema.date, endDate.toISOString().split("T")[0]));
    }

    const result = await this.db
      .select({ totalDuration: sum(userLearningActivitiesSchema.duration) })
      .from(userLearningActivitiesSchema)
      .where(and(...conditions));

    return Number(result[0]?.totalDuration || 0);
  }
}

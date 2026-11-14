import { asc, eq } from "drizzle-orm";

import {
  courseHistory as courseHistorySchema,
  coursePack as coursePackSchema,
  statement as statementSchema,
  userCourseProgress as userCourseProgressSchema,
} from "@earthworm/schema";
import type { CreateCoursePack, WordTiming } from "./course-pack.model";
import { db } from "../db";

export async function createCoursePack(coursePackInfo: CreateCoursePack) {
  const result = await db.transaction(async (tx) => {
    const coursePackOrder = await calculateCoursePackOrder();

    const [coursePackEntity] = await tx
      .insert(coursePackSchema)
      .values({
        order: coursePackOrder,
        title: coursePackInfo.title,
        description: coursePackInfo.description,
        cover: coursePackInfo.cover,
        video: coursePackInfo.video ?? "",
      })
      .returning();

    const createStatementTasks = coursePackInfo.courses.statements.map(
      ({ chinese, english, phonetic, startTime, endTime, words }, sIndex) => {
        return tx.insert(statementSchema).values({
          chinese,
          english,
          soundmark: phonetic,
          startTime: startTime ?? null,
          endTime: endTime ?? null,
          words: words ?? null,
          order: sIndex + 1,
          coursePackId: coursePackEntity.id,
        });
      },
    );

    await Promise.all(createStatementTasks);

    return {
      coursePackId: coursePackEntity.id,
    };

    async function calculateCoursePackOrder() {
      const entity = await tx.query.coursePack.findFirst({
        orderBy: (table, { desc }) => [desc(table.order)],
      });

      if (entity) {
        return entity.order + 1;
      }

      return 1;
    }
  });

  return result;
}

export async function deleteCoursePack(coursePackId: string) {
  const result = await db.transaction(async (tx) => {
    const coursePack = await tx.query.coursePack.findFirst({
      where: eq(coursePackSchema.id, coursePackId),
    });

    if (!coursePack) {
      throw new Error("not found course pack");
    }

    await tx.delete(statementSchema).where(eq(statementSchema.coursePackId, coursePackId));
    await tx.delete(coursePackSchema).where(eq(coursePackSchema.id, coursePackId));

    // 还需要删除 course_history
    // 和 user_course_progress 里面的记录
    await tx.delete(courseHistorySchema).where(eq(courseHistorySchema.coursePackId, coursePackId));

    await tx
      .delete(userCourseProgressSchema)
      .where(eq(userCourseProgressSchema.coursePackId, coursePackId));

    return true;
  });

  return result;
}

/**
 * 更新课程包：在同一事务内改元信息（title/description/cover/video），
 * 删除原有句子并按新列表顺序重建。
 * 编辑表单不回传视频时间戳，重建时按位置比对 english：
 * 未变的行保留原 startTime/endTime/words，变了的行置 null（视频同步失效，回退音频/TTS）。
 */
export async function updateCoursePack(coursePackId: string, coursePackInfo: CreateCoursePack) {
  const result = await db.transaction(async (tx) => {
    const [updatedPack] = await tx
      .update(coursePackSchema)
      .set({
        title: coursePackInfo.title,
        description: coursePackInfo.description,
        cover: coursePackInfo.cover,
        ...(coursePackInfo.video !== undefined ? { video: coursePackInfo.video } : {}),
      })
      .where(eq(coursePackSchema.id, coursePackId))
      .returning();

    if (!updatedPack) {
      throw new Error("not found course pack");
    }

    const previousStatements = await tx.query.statement.findMany({
      where: eq(statementSchema.coursePackId, coursePackId),
      orderBy: asc(statementSchema.order),
    });

    await tx.delete(statementSchema).where(eq(statementSchema.coursePackId, coursePackId));

    const createStatementTasks = coursePackInfo.courses.statements.map(
      ({ chinese, english, phonetic, startTime, endTime, words }, sIndex) => {
        const prev = previousStatements[sIndex];
        const unchanged = prev !== undefined && prev.english === english;
        return tx.insert(statementSchema).values({
          chinese,
          english,
          soundmark: phonetic,
          startTime: startTime ?? (unchanged ? prev.startTime : null),
          endTime: endTime ?? (unchanged ? prev.endTime : null),
          words: words ?? (unchanged ? (prev.words as WordTiming[] | null) : null),
          order: sIndex + 1,
          coursePackId,
        });
      },
    );

    await Promise.all(createStatementTasks);

    return {
      coursePackId,
    };
  });

  return result;
}

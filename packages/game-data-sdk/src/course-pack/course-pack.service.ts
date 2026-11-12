import { eq } from "drizzle-orm";

import {
  courseHistory as courseHistorySchema,
  coursePack as coursePackSchema,
  statement as statementSchema,
  userCourseProgress as userCourseProgressSchema,
} from "@earthworm/schema";
import type { CreateCoursePack } from "./course-pack.model";
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
      })
      .returning();

    const createStatementTasks = coursePackInfo.courses.statements.map(
      ({ chinese, english, phonetic, audioUrl }, sIndex) => {
        return tx.insert(statementSchema).values({
          chinese,
          english,
          soundmark: phonetic,
          audioUrl: audioUrl ?? null,
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
 * 更新课程包：在同一事务内改元信息（title/description/cover），
 * 删除原有句子并按新列表顺序重建。
 * audioUrl 目前是占位字段，不参与编辑逻辑（重建时走默认 null）。
 */
export async function updateCoursePack(coursePackId: string, coursePackInfo: CreateCoursePack) {
  const result = await db.transaction(async (tx) => {
    const [updatedPack] = await tx
      .update(coursePackSchema)
      .set({
        title: coursePackInfo.title,
        description: coursePackInfo.description,
        cover: coursePackInfo.cover,
      })
      .where(eq(coursePackSchema.id, coursePackId))
      .returning();

    if (!updatedPack) {
      throw new Error("not found course pack");
    }

    await tx.delete(statementSchema).where(eq(statementSchema.coursePackId, coursePackId));

    const createStatementTasks = coursePackInfo.courses.statements.map(
      ({ chinese, english, phonetic, audioUrl }, sIndex) => {
        return tx.insert(statementSchema).values({
          chinese,
          english,
          soundmark: phonetic,
          audioUrl: audioUrl ?? null,
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

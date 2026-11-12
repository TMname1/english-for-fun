import { DbType } from "src/global/providers/db.provider";

import { coursePack, statement, userCourseProgress } from "@earthworm/schema";

type CoursePackInsert = typeof coursePack.$inferInsert;

export async function insertCoursePack(db: DbType, values?: Partial<CoursePackInsert>) {
  const defaultCoursePack = {
    order: 1,
    title: "课程包",
    description: "这是一个课程包",
  } satisfies CoursePackInsert;

  const [entity] = await db
    .insert(coursePack)
    .values({
      ...defaultCoursePack,
      ...values,
    })
    .returning();

  return entity;
}

type StatementInsert = typeof statement.$inferInsert;
export async function insertStatement(
  db: DbType,
  coursePackId: string,
  order: number,
  values?: Partial<StatementInsert>,
) {
  const defaultStatement = {
    order,
    coursePackId,
    chinese: "你好",
    english: "hello",
    soundmark: "nihao",
  } satisfies StatementInsert;

  const [entity] = await db
    .insert(statement)
    .values({
      ...defaultStatement,
      ...values,
    })
    .returning();

  return entity;
}

export async function insertUserCourseProgress(
  db: DbType,
  coursePackId: string,
  statementIndex: number,
) {
  const [entity] = await db
    .insert(userCourseProgress)
    .values({
      coursePackId,
      statementIndex,
    })
    .returning();

  return entity;
}

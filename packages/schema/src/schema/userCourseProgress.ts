import { createId } from "@paralleldrive/cuid2";
import { integer, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

export const userCourseProgress = pgTable(
  "user_course_progress",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    coursePackId: text("course_pack_id").notNull(),
    /**
     * from Statement's order
     */
    statementIndex: integer("statement_index").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").$onUpdateFn(() => new Date()),
  },
  (t) => ({
    unq: unique().on(t.coursePackId),
  }),
);

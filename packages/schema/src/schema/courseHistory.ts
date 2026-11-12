import { createId } from "@paralleldrive/cuid2";
import { integer, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

export const courseHistory = pgTable(
  "course_history",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    coursePackId: text("course_pack_id").notNull(),
    completionCount: integer("completion_count").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").$onUpdateFn(() => new Date()),
  },
  (t) => ({
    unq: unique().on(t.coursePackId),
  }),
);

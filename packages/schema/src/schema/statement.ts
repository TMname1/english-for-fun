import { createId } from "@paralleldrive/cuid2";
import { relations } from "drizzle-orm";
import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { coursePack } from "./coursePack";

export const statement = pgTable("statements", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  order: integer("order").notNull(),
  chinese: text("chinese").notNull(),
  english: text("english").notNull(),
  soundmark: text("soundmark").notNull(),
  /** 真实音频切片的可访问路径（如 /course-audio/xxx.mp3）；为空时回退 TTS */
  audioUrl: text("audio_url"),
  coursePackId: text("course_pack_id")
    .notNull()
    .references(() => coursePack.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").$onUpdateFn(() => new Date()),
});

export const statementRelations = relations(statement, ({ one }) => ({
  coursePack: one(coursePack, {
    fields: [statement.coursePackId],
    references: [coursePack.id],
  }),
}));

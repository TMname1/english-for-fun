import { createId } from "@paralleldrive/cuid2";
import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const coursePack = pgTable("course_packs", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  order: integer("order").notNull(),
  title: text("title").notNull(),
  description: text("description").default(""),
  cover: text("cover"),
  /** 课程配套视频链接（原 courses.video 列，随删除分课程功能迁移至此） */
  video: text("video").default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").$onUpdateFn(() => new Date()),
});

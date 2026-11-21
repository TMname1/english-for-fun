import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * B 站扫码登录得到的 cookie jar（SESSDATA 等）。
 * 单行表：固定一行 id，全部署共用一个账号，登录态从原先的本地 cookies.json 迁到此处持久化。
 */
export const biliCookie = pgTable("bili_cookie", {
  id: text("id").primaryKey(),
  data: jsonb("data").notNull(),
  updatedAt: timestamp("updated_at").$onUpdateFn(() => new Date()),
});

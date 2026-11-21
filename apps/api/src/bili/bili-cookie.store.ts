import { eq } from "drizzle-orm";

import { biliCookie } from "@earthworm/schema";
import type { DbType } from "../global/providers/db.provider";
import type { CookieStore } from "./bilidown-bridge";

/** 单行表的固定主键：全部署共用一个 B 站账号，登录态持久化在 bili_cookie 表。 */
export const BILI_COOKIE_ROW_ID = "bili";

export function createDbCookieStore(db: DbType): CookieStore {
  return {
    async load() {
      const row = await db.query.biliCookie.findFirst({
        where: eq(biliCookie.id, BILI_COOKIE_ROW_ID),
      });
      return (row?.data as Record<string, string>) ?? {};
    },
    async save(jar) {
      await db
        .insert(biliCookie)
        .values({ id: BILI_COOKIE_ROW_ID, data: jar })
        .onConflictDoUpdate({
          target: biliCookie.id,
          set: { data: jar, updatedAt: new Date() },
        });
    },
  };
}

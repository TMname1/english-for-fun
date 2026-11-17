import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql } from "drizzle-orm";
import { DbType } from "src/global/providers/db.provider";
import * as request from "supertest";

import { GlobalModule } from "../../src/global/global.module";

export async function cleanDB(db: DbType) {
  await db.execute(
    sql`TRUNCATE TABLE statements, "course_packs" , "user_course_progress", "course_history", "user_learning_activities", "mastered_elements" RESTART IDENTITY CASCADE;`,
  );
}

export const testImportModules = [GlobalModule];

/** 全局认证中间件要求登录；返回已登录、自动携带 Cookie 的 supertest agent */
export async function createAuthedAgent(
  app: INestApplication,
): Promise<ReturnType<typeof request.agent>> {
  const config = app.get(ConfigService);
  const agent = request.agent(app.getHttpServer());
  await agent
    .post("/auth/login")
    .send({
      username: config.getOrThrow<string>("AUTH_USERNAME"),
      password: config.getOrThrow<string>("AUTH_PASSWORD"),
    })
    .expect(201);
  return agent;
}

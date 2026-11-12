import { Logger } from "@nestjs/common";
import { DefaultLogger, LogWriter } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import * as postgres from "postgres";

import { schemas } from "@earthworm/schema";

let connection: postgres.Sql;

/**
 * 启动自检用的必需表；新增表时手工补一行。
 * dev:serve 不会建表，缺表时每个请求都会 500（relation "..." does not exist），
 * 所以在建立连接后一次性检查，把问题在启动阶段说清楚。
 */
const REQUIRED_TABLES = [
  "course_packs",
  "statements",
  "course_history",
  "mastered_elements",
  "user_course_progress",
  "user_learning_activities",
];

/**
 * 校验目标库里表是否齐全，缺表就抛出带修复步骤的错误。
 * 测试环境（NODE_ENV=test）跳过：建表时机由测试脚本 / CI 决定，不能在这里拦住启动。
 */
async function assertRequiredTables() {
  if (process.env.NODE_ENV === "test") {
    return;
  }

  const rows = await connection<
    { table_name: string }[]
  >`select table_name from information_schema.tables where table_schema = 'public'`;

  const existing = new Set(rows.map((row) => row.table_name));
  const missing = REQUIRED_TABLES.filter((table) => !existing.has(table));
  if (missing.length === 0) {
    return;
  }

  // 启动即将失败，先把连接释放掉，避免遗留 socket 让进程挂住
  const databaseUrl = process.env.DATABASE_URL ?? "";
  await endDB();

  throw new Error(
    [
      `数据库表缺失：${missing.join(", ")}`,
      `当前连接：${databaseUrl || "（DATABASE_URL 未设置）"}`,
      "修复步骤：pnpm docker:start && pnpm db:init（首次建库还需要 pnpm db:upload 导入课程数据），然后重新启动 pnpm dev:serve",
      "若 DATABASE_URL 指向了别的库，请检查 apps/api/.env",
    ].join("\n"),
  );
}

async function createConnection() {
  return postgres(process.env.DATABASE_URL ?? "");
}

export async function endDB() {
  if (connection) {
    await connection.end();
    connection = null;
  }
}

export async function setupDB() {
  if (connection) return;

  const logger = new Logger("DB");

  class CustomDbLogWriter implements LogWriter {
    write(message: string) {
      logger.verbose(message);
    }
  }

  logger.debug(`Connecting to ${process.env.DATABASE_URL}`);

  connection = await createConnection();

  await assertRequiredTables();

  return drizzle(connection, {
    schema: schemas,
    logger: new DefaultLogger({ writer: new CustomDbLogWriter() }),
  });
}

import { readFile } from "node:fs/promises";

import type { ForgePayload } from "./types";
import { config } from "./config";
import { paths } from "./forge";

interface CreateCoursePackResponse {
  coursePackId: string;
}

/**
 * 导入产物：course.json -> POST /course-pack。
 * 不携带音频字段：数据库 audio_url 列保持现状（NULL），由后续流程填充。
 * 前提：API 已启动。
 */
export async function forgeImport(outDir: string): Promise<CreateCoursePackResponse> {
  const payload = JSON.parse(await readFile(paths.course(outDir), "utf-8")) as ForgePayload;

  // 提交课程包（不含 audioUrl）：courses 为单一课程对象
  const body = {
    title: payload.title,
    description: payload.description ?? "",
    cover: payload.cover ?? "",
    courses: {
      title: payload.courses.title,
      description: payload.courses.description ?? "",
      statements: payload.courses.statements.map((statement) => ({
        english: statement.english,
        chinese: statement.chinese,
        phonetic: statement.phonetic ?? "",
      })),
    },
  };

  const url = `${config.apiBaseUrl.replace(/\/$/, "")}/course-pack`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new Error(
      `[import] 无法连接 API（${url}）。请确认后端已启动：pnpm dev:serve。原始错误: ${(error as Error).message}`,
    );
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`[import] 创建课程包失败（HTTP ${res.status}）: ${text.slice(0, 600)}`);
  }

  const result = JSON.parse(text) as CreateCoursePackResponse;
  console.log(
    `[import] 导入成功：coursePackId=${result.coursePackId}。打开客户端即可在课程列表看到《${payload.title}》`,
  );
  return result;
}

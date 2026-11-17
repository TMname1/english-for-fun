import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

import type { ForgeMeta, ForgePayload } from "./types";
import { config } from "./config";
import { paths } from "./forge";

interface CreateCoursePackResponse {
  coursePackId: string;
}

/**
 * 视频输入的运行：把视频复制到 API 的静态目录（/course-video），返回站内 URL。
 * 文件名带 runId 保证不可变语义（静态挂载是 maxAge 365d + immutable）。
 * 非 mp4 只警告不转码：Safari 等浏览器可能无法播放 mkv/webm，需要时手工转 H.264+AAC mp4。
 */
async function publishVideo(meta: ForgeMeta): Promise<string | null> {
  if (!meta.videoPath || !existsSync(meta.videoPath)) {
    return null;
  }
  const ext = extname(meta.videoPath).toLowerCase();
  if (ext !== ".mp4") {
    console.warn(
      `[import] 警告：视频不是 mp4（${ext}），部分浏览器（Safari）可能无法播放；建议转成 H.264+AAC 的 mp4 再导入`,
    );
  }
  const fileName = `${meta.runId}${ext}`;
  const targetDir = resolve(config.courseVideoDir);
  await mkdir(targetDir, { recursive: true });
  await copyFile(meta.videoPath, join(targetDir, fileName));
  console.log(`[import] 视频已复制到 ${join(targetDir, fileName)}`);
  return `/course-video/${fileName}`;
}

/** API 已启用单用户登录：导入前先 POST /auth/login 换取 Cookie */
async function loginToApi(): Promise<string> {
  if (!config.authUsername || !config.authPassword) {
    throw new Error(
      "[import] 未配置 AUTH_USERNAME/AUTH_PASSWORD（packages/course-forge/.env 或进程环境变量），无法登录 API",
    );
  }
  const url = `${config.apiBaseUrl.replace(/\/$/, "")}/auth/login`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: config.authUsername, password: config.authPassword }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(
      `[import] 登录 API 失败（HTTP ${res.status}）：请检查 AUTH_USERNAME/AUTH_PASSWORD`,
    );
  }
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error("[import] 登录 API 成功但未返回 Cookie");
  }
  return setCookie.split(";")[0];
}

/**
 * 导入产物：course.json -> POST /course-pack。
 * statement 携带视频时间戳（startTime/endTime/words，由 forge 的对齐步骤产出）；
 * 视频输入时复制视频文件并写入 course_packs.video（播放走视频 seek 或 TTS）。
 * 前提：API 已启动，且与本机共享 storage 目录（默认 apps/api/storage/course-video）。
 */
export async function forgeImport(outDir: string): Promise<CreateCoursePackResponse> {
  const payload = JSON.parse(await readFile(paths.course(outDir), "utf-8")) as ForgePayload;
  const metaFile = paths.meta(outDir);
  const meta = existsSync(metaFile)
    ? (JSON.parse(await readFile(metaFile, "utf-8")) as ForgeMeta)
    : null;

  const videoUrl = meta ? await publishVideo(meta) : null;

  const body = {
    title: payload.title,
    description: payload.description ?? "",
    cover: payload.cover ?? "",
    video: videoUrl ?? undefined,
    courses: {
      title: payload.courses.title,
      description: payload.courses.description ?? "",
      statements: payload.courses.statements.map((statement) => ({
        english: statement.english,
        chinese: statement.chinese,
        phonetic: statement.phonetic ?? "",
        startTime: statement.startTime ?? undefined,
        endTime: statement.endTime ?? undefined,
        words: statement.words ?? undefined,
      })),
    },
  };

  const url = `${config.apiBaseUrl.replace(/\/$/, "")}/course-pack`;
  const cookie = await loginToApi();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
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

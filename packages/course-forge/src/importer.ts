import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import { ObjectStorage, storageConfigFromEnv } from "@earthworm/storage";
import type { ForgeMeta, ForgePayload } from "./types";
import { config } from "./config";
import { paths } from "./forge";

interface CreateCoursePackResponse {
  coursePackId: string;
}

/**
 * 视频输入的运行：把视频上传到对象存储 course-video/<runId><ext>，返回对象键（入库用）。
 * 文件名带 runId 保证不可变语义。
 * 非 mp4 只警告不转码：Safari 等浏览器可能无法播放 mkv/webm，需要时手工转 H.264+AAC mp4。
 */
async function publishVideo(meta: ForgeMeta, storage: ObjectStorage): Promise<string | null> {
  if (!meta.videoPath || !existsSync(meta.videoPath)) {
    return null;
  }
  const ext = extname(meta.videoPath).toLowerCase();
  if (ext !== ".mp4") {
    console.warn(
      `[import] 警告：视频不是 mp4（${ext}），部分浏览器（Safari）可能无法播放；建议转成 H.264+AAC 的 mp4 再导入`,
    );
  }
  const videoKey = `course-video/${meta.runId}${ext}`;
  await storage.uploadFile(videoKey, meta.videoPath);
  console.log(`[import] 视频已上传到对象存储：${videoKey}`);
  return videoKey;
}

/** 把本地 outDir 的 JSON 产物持久化到 forge/<runId>/（与 GUI 流水线的对象布局一致） */
async function publishArtifacts(outDir: string, runId: string, storage: ObjectStorage) {
  const files = [
    paths.meta(outDir),
    paths.transcript(outDir),
    paths.transcriptRaw(outDir),
    paths.clips(outDir),
    paths.alignment(outDir),
    paths.course(outDir),
  ];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const name = file.split(/[\\/]/).pop()!;
    await storage.putBuffer(`forge/${runId}/${name}`, await readFile(file), "application/json");
  }
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
 * 视频输入时上传视频到对象存储并把对象键写入 course_packs.video（播放走预签名 URL）。
 * 前提：API 已启动；对象存储配置（S3_*）与 API 指向同一个桶。
 */
export async function forgeImport(outDir: string): Promise<CreateCoursePackResponse> {
  const payload = JSON.parse(await readFile(paths.course(outDir), "utf-8")) as ForgePayload;
  const metaFile = paths.meta(outDir);
  const meta = existsSync(metaFile)
    ? (JSON.parse(await readFile(metaFile, "utf-8")) as ForgeMeta)
    : null;

  const storage = new ObjectStorage(storageConfigFromEnv());
  const videoKey = meta ? await publishVideo(meta, storage) : null;
  if (meta) {
    await publishArtifacts(outDir, meta.runId, storage);
  }

  const body = {
    title: payload.title,
    description: payload.description ?? "",
    cover: payload.cover ?? "",
    video: videoKey ?? undefined,
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

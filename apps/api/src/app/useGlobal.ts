import { join } from "node:path";
import type { NestExpressApplication } from "@nestjs/platform-express";

import { INestApplication, ValidationPipe } from "@nestjs/common";

import { createAuthMiddleware } from "../auth/auth.middleware";
import { AuthService } from "../auth/auth.service";
import { HttpExceptionFilter } from "./exception.filter";

export const appGlobalMiddleware = (app: INestApplication) => {
  app.useGlobalPipes(new ValidationPipe());
  app.useGlobalFilters(new HttpExceptionFilter());

  // 单用户登录：除 POST /auth/login 外所有请求（含静态音视频、Swagger）都要求登录 Cookie
  app.use(createAuthMiddleware(app.get(AuthService)));

  // 真实音频切片（如 /course-audio/xxx.mp3），课程导入脚本会把切片写入该目录
  const courseAudioDir =
    process.env.COURSE_AUDIO_DIR || join(process.cwd(), "storage", "course-audio");
  (app as NestExpressApplication).useStaticAssets(courseAudioDir, {
    prefix: "/course-audio",
    maxAge: "365d",
    immutable: true,
    index: false,
  });

  // 课程配套视频（如 /course-video/xxx.mp4），forge 导入脚本会把视频写入该目录；
  // 前端 <video> seek 依赖 HTTP Range，serve-static 原生支持
  const courseVideoDir =
    process.env.COURSE_VIDEO_DIR || join(process.cwd(), "storage", "course-video");
  (app as NestExpressApplication).useStaticAssets(courseVideoDir, {
    prefix: "/course-video",
    maxAge: "365d",
    immutable: true,
    index: false,
  });
};

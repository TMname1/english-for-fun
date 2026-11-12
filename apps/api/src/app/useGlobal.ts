import { join } from "node:path";
import type { NestExpressApplication } from "@nestjs/platform-express";

import { INestApplication, ValidationPipe } from "@nestjs/common";

import { HttpExceptionFilter } from "./exception.filter";

export const appGlobalMiddleware = (app: INestApplication) => {
  app.useGlobalPipes(new ValidationPipe());
  app.useGlobalFilters(new HttpExceptionFilter());

  // 真实音频切片（如 /course-audio/xxx.mp3），课程导入脚本会把切片写入该目录
  const courseAudioDir =
    process.env.COURSE_AUDIO_DIR || join(process.cwd(), "storage", "course-audio");
  (app as NestExpressApplication).useStaticAssets(courseAudioDir, {
    prefix: "/course-audio",
    maxAge: "365d",
    immutable: true,
    index: false,
  });
};

import { INestApplication, ValidationPipe } from "@nestjs/common";

import { createAuthMiddleware } from "../auth/auth.middleware";
import { AuthService } from "../auth/auth.service";
import { HttpExceptionFilter } from "./exception.filter";

export const appGlobalMiddleware = (app: INestApplication) => {
  app.useGlobalPipes(new ValidationPipe());
  app.useGlobalFilters(new HttpExceptionFilter());

  // 单用户登录：除 POST /auth/login 外所有请求（含 Swagger）都要求登录 Cookie；
  // 音视频走对象存储预签名 URL 直连，不再经过 API 静态挂载
  app.use(createAuthMiddleware(app.get(AuthService)));
};

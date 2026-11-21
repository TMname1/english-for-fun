import { Logger } from "@nestjs/common";
import { NestApplication, NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

import { AppModule } from "./app/app.module";
import { appGlobalMiddleware } from "./app/useGlobal";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // 默认 json body 上限 100kb；课程包导入携带逐词时间戳，长视频产物可达数百 KB。
  // useBodyParser 在运行时的 NestApplication 上存在，但当前版本 INestApplication 接口未声明，故按具体类断言。
  (app as NestApplication).useBodyParser("json", { limit: "10mb" });
  app.enableCors({
    origin: [
      /^http:\/\/localhost(:\d+)?$/,
      /^http:\/\/earthworm\.cuixueshe\.com(:81)?$/,
      /^https:\/\/bananablog\.cc$/,
      /^https:\/\/([\w-]+?\.)?english-for-fun-d7h\.pages\.dev$/,
    ],
    credentials: true,
  });

  appGlobalMiddleware(app);
  const config = new DocumentBuilder()
    .setTitle("EarthWorm Swagger")
    .setDescription("The EarthWorm API description")
    .setVersion("v1.0")
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("/swagger", app, document);
  await app.listen(process.env.PORT || 3001);
}

bootstrap().catch((error: unknown) => {
  const logger = new Logger("Bootstrap");
  logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

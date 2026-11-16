import { Module } from "@nestjs/common";

import { ForgeModule } from "../forge/forge.module";
import { BiliController } from "./bili.controller";
import { BiliService } from "./bili.service";

@Module({
  imports: [ForgeModule],
  controllers: [BiliController],
  providers: [BiliService],
})
export class BiliModule {}

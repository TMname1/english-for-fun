import { Module } from "@nestjs/common";

import { ForgeController } from "./forge.controller";
import { ForgeService } from "./forge.service";
import { JobStore } from "./job-store";

@Module({
  controllers: [ForgeController],
  providers: [ForgeService, JobStore],
})
export class ForgeModule {}

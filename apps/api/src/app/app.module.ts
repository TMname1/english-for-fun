import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { BiliModule } from "../bili/bili.module";
import { CourseHistoryModule } from "../course-history/course-history.module";
import { CoursePackModule } from "../course-pack/course-pack.module";
import { ForgeModule } from "../forge/forge.module";
import { GlobalModule } from "../global/global.module";
import { MasteredElementModule } from "../mastered-element/mastered-element.module";
import { StorageModule } from "../storage/storage.module";
import { ToolModule } from "../tool/tool.module";
import { TtsModule } from "../tts/tts.module";
import { UserCourseProgressModule } from "../user-course-progress/user-course-progress.module";
import { UserLearningActivityModule } from "../user-learning-activity/user-learning-activity.module";

@Module({
  imports: [
    GlobalModule,
    StorageModule,
    AuthModule,
    CoursePackModule,
    UserCourseProgressModule,
    UserLearningActivityModule,
    ToolModule,
    CourseHistoryModule,
    MasteredElementModule,
    TtsModule,
    ForgeModule,
    BiliModule,
  ],
})
export class AppModule {}

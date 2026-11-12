import { Module } from "@nestjs/common";

import { CourseHistoryModule } from "../course-history/course-history.module";
import { UserCourseProgressModule } from "../user-course-progress/user-course-progress.module";
import { CoursePackController } from "./course-pack.controller";
import { CoursePackService } from "./course-pack.service";

@Module({
  imports: [UserCourseProgressModule, CourseHistoryModule],
  providers: [CoursePackService],
  controllers: [CoursePackController],
})
export class CoursePackModule {}

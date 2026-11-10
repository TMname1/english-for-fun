import { Body, Controller, Get, Put, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { UpsertUserProgressDto } from "./model/user-progress.dto";
import { UserCourseProgressService } from "./user-course-progress.service";

@ApiTags("UserProgress")
@Controller("user-course-progress")
export class UserProgressController {
  constructor(private readonly userCourseProgressService: UserCourseProgressService) {}

  @Get("/recent-course-packs")
  async getRecentCoursePacks(@Query("limit") limit: number) {
    return await this.userCourseProgressService.getRecentCoursePacks(limit || 3);
  }

  @Put()
  async upsert(@Body() dto: UpsertUserProgressDto) {
    return await this.userCourseProgressService.upsert(
      dto.coursePackId,
      dto.courseId,
      dto.statementIndex,
    );
  }
}

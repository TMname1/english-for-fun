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
    return await this.userCourseProgressService.getRecentCoursePacks(this.resolveLimit(limit));
  }

  @Put()
  async upsert(@Body() dto: UpsertUserProgressDto) {
    return await this.userCourseProgressService.upsert(
      dto.coursePackId,
      dto.courseId,
      dto.statementIndex,
    );
  }

  /**
   * 首页最近课程包最多展示 3 个，解析并限制 limit 在 1-3 之间，非法值回退为 3。
   */
  private resolveLimit(limit: number | string | undefined): number {
    const parsedLimit = Number.parseInt(String(limit), 10);

    if (Number.isNaN(parsedLimit)) {
      return 3;
    }

    return Math.min(Math.max(parsedLimit, 1), 3);
  }
}

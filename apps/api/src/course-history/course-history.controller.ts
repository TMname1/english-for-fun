import { Controller, Get, Param } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";

import { CourseHistoryService } from "./course-history.service";

@ApiTags("CourseHistory")
@Controller("course-history")
export class CourseHistoryController {
  constructor(private readonly courseHistoryService: CourseHistoryService) {}

  @ApiOperation({
    summary: "获取所有课程历史记录",
  })
  @Get("")
  courseCompletionCount() {
    return this.courseHistoryService.findAll();
  }

  @Get(":coursePackId")
  getCoursePackHistory(@Param("coursePackId") coursePackId: string) {
    return this.courseHistoryService.findByCoursePackId(coursePackId);
  }
}

import { Body, Controller, Get, Post, Query } from "@nestjs/common";

import { QueryParamsDto } from "./model/query-params.dto";
import { UpsertActivityDto } from "./model/upsert-activity.dto";
import { UserLearningActivityService } from "./user-learning-activity.service";

@Controller("user-learning-activities")
export class UserLearningActivityController {
  constructor(private userLearningActivityService: UserLearningActivityService) {}

  @Get()
  async getDailyTotals(@Query() queryParams: QueryParamsDto) {
    const { activityType, startDate, endDate } = queryParams;
    const start = startDate ? new Date(startDate) : undefined;
    const end = endDate ? new Date(endDate) : undefined;
    return this.userLearningActivityService.getDailyTotalTime(activityType, start, end);
  }

  @Post()
  async upsertActivity(@Body() activityData: UpsertActivityDto) {
    return await this.userLearningActivityService.upsertActivity(
      new Date(activityData.date),
      activityData.activityType,
      activityData.duration,
    );
  }

  @Get("total")
  async getTotalLearningTime(@Query() queryParams: QueryParamsDto) {
    const { activityType, startDate, endDate } = queryParams;
    const start = startDate ? new Date(startDate) : undefined;
    const end = endDate ? new Date(endDate) : undefined;
    return await this.userLearningActivityService.getTotalLearningTime(activityType, start, end);
  }
}

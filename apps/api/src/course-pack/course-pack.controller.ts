import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";

import { CoursePackService } from "./course-pack.service";
import { CreateCoursePackDto } from "./dto/create-course-pack.dto";

@Controller("course-pack")
export class CoursePackController {
  constructor(private readonly coursePackService: CoursePackService) {}

  @Get()
  async findAll() {
    return await this.coursePackService.findAll();
  }

  @Post()
  async create(@Body() createCoursePackDto: CreateCoursePackDto) {
    return await this.coursePackService.create(createCoursePackDto);
  }

  @Delete(":coursePackId")
  async remove(@Param("coursePackId") coursePackId: string) {
    return await this.coursePackService.delete(coursePackId);
  }

  /** 课程包详情（含学习完成次数） */
  @Get(":coursePackId")
  async findOne(@Param("coursePackId") coursePackId: string) {
    return await this.coursePackService.findOneWithCompletion(coursePackId);
  }

  /** 学习内容：课程包内唯一课程的 statements（按 order）+ 用户当前进度 */
  @Get(":coursePackId/learning")
  findLearning(@Param("coursePackId") coursePackId: string) {
    return this.coursePackService.findLearning(coursePackId);
  }

  /** 编辑用详情：课程包元信息 + 句子（供「修改课程」表单预填，不含用户进度） */
  @Get(":coursePackId/edit")
  findForEdit(@Param("coursePackId") coursePackId: string) {
    return this.coursePackService.findForEdit(coursePackId);
  }

  /** 修改课程包：更新元信息并重建句子 */
  @Patch(":coursePackId")
  async update(
    @Param("coursePackId") coursePackId: string,
    @Body() updateCoursePackDto: CreateCoursePackDto,
  ) {
    return await this.coursePackService.update(coursePackId, updateCoursePackDto);
  }

  /** 完成一次课程学习：累计该课程包的 completionCount */
  @Post(":coursePackId/complete")
  completeCoursePack(@Param("coursePackId") coursePackId: string) {
    return this.coursePackService.completeCoursePack(coursePackId);
  }
}

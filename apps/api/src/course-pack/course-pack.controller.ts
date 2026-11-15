import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { extname } from "node:path";

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";

import { COURSE_VIDEO_DIR } from "../forge/runner-client";
import { CoursePackService } from "./course-pack.service";
import { CreateCoursePackDto } from "./dto/create-course-pack.dto";

/** 与 forge.controller / course-forge 的视频白名单保持一致 */
const VIDEO_EXT_WHITELIST = new Set([".mp4", ".m4v", ".mkv", ".webm", ".mov", ".avi"]);
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;

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

  /**
   * 上传本地视频文件到课程视频静态目录（不跑 ASR），返回站内路径。
   * 添加/修改课程表单用它把视频落到 /course-video，再回填到 video 字段。
   */
  @Post("video")
  @UseInterceptors(
    FileInterceptor("videoFile", {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          if (!existsSync(COURSE_VIDEO_DIR)) {
            mkdirSync(COURSE_VIDEO_DIR, { recursive: true });
          }
          cb(null, COURSE_VIDEO_DIR);
        },
        filename: (_req, file, cb) => {
          const ext = extname(file.originalname).toLowerCase();
          cb(null, `${randomUUID()}${ext}`);
        },
      }),
      limits: { fileSize: MAX_VIDEO_BYTES },
      fileFilter: (_req, file, cb) => {
        const ext = extname(file.originalname).toLowerCase();
        if (!VIDEO_EXT_WHITELIST.has(ext)) {
          cb(new BadRequestException(`不支持的视频格式：${ext || "(无扩展名)"}`), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  uploadVideo(@UploadedFile() file: Express.Multer.File | undefined) {
    if (!file) {
      throw new BadRequestException("缺少视频文件 videoFile");
    }
    return { video: `/course-video/${file.filename}` };
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

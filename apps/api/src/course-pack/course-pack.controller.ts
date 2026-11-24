import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";

import { isAllowedMediaExt, MEDIA_EXT_LABELS, mediaKindOf } from "../common/media-ext";
import { StorageService } from "../storage/storage.service";
import { CoursePackService } from "./course-pack.service";
import { CreateCoursePackDto } from "./dto/create-course-pack.dto";

/** 音视频统一白名单（见 src/common/media-ext.ts） */
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
/** multer 落盘只是中转，上传对象存储后即删 */
const UPLOAD_TMP_DIR = join(tmpdir(), "earthworm-uploads");

@Controller("course-pack")
export class CoursePackController {
  constructor(
    private readonly coursePackService: CoursePackService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  async findAll() {
    return await this.coursePackService.findAll();
  }

  @Post()
  async create(@Body() createCoursePackDto: CreateCoursePackDto) {
    return await this.coursePackService.create(createCoursePackDto);
  }

  /**
   * 上传本地视频/音频文件到对象存储（不跑 ASR），返回对象键、预签名预览 URL 与媒体类型。
   * 添加/修改课程表单用对象键回填 video 字段（入库），URL 仅供即时预览。
   */
  @Post("video")
  @UseInterceptors(
    FileInterceptor("videoFile", {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          if (!existsSync(UPLOAD_TMP_DIR)) {
            mkdirSync(UPLOAD_TMP_DIR, { recursive: true });
          }
          cb(null, UPLOAD_TMP_DIR);
        },
        filename: (_req, file, cb) => {
          const ext = extname(file.originalname).toLowerCase();
          cb(null, `${randomUUID()}${ext}`);
        },
      }),
      limits: { fileSize: MAX_VIDEO_BYTES },
      fileFilter: (_req, file, cb) => {
        const ext = extname(file.originalname).toLowerCase();
        if (!isAllowedMediaExt(ext)) {
          cb(
            new BadRequestException(
              `不支持的媒体格式：${ext || "(无扩展名)"}（支持 ${MEDIA_EXT_LABELS}）`,
            ),
            false,
          );
          return;
        }
        cb(null, true);
      },
    }),
  )
  async uploadVideo(@UploadedFile() file: Express.Multer.File | undefined) {
    if (!file) {
      throw new BadRequestException("缺少媒体文件 videoFile");
    }
    const videoKey = `course-video/${file.filename}`;
    try {
      // 透传 Content-Type，浏览器才能正确解码播放
      await this.storage.uploadFile(videoKey, file.path, file.mimetype);
    } finally {
      await rm(file.path, { force: true }).catch(() => {});
    }
    return {
      video: videoKey,
      videoUrl: await this.storage.presignGet(videoKey),
      mediaKind: mediaKindOf(videoKey),
    };
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

  /**
   * 课程目录分页：一次只取一页（默认/最多 100 条），支持 filter=all|mastered|notMastered。
   * 句子多时目录不必拉全量，前端按页请求。
   */
  @Get(":coursePackId/statements")
  findStatementsPage(
    @Param("coursePackId") coursePackId: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
    @Query("filter") filter?: string,
  ) {
    return this.coursePackService.findStatementsPage(coursePackId, { page, pageSize, filter });
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

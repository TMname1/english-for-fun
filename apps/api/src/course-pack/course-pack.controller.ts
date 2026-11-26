import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { extname } from "node:path";

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";

import {
  isAllowedMediaExt,
  MAX_MEDIA_BYTES,
  MEDIA_EXT_LABELS,
  mediaKindOf,
} from "../common/media-ext";
import {
  CompleteMediaUploadDto,
  presignMediaUpload,
  PresignMediaUploadDto,
  verifyUploadedMedia,
} from "../common/media-upload";
import { UPLOAD_TMP_DIR } from "../common/upload-tmp";
import { StorageService } from "../storage/storage.service";
import { CoursePackService } from "./course-pack.service";
import { CreateCoursePackDto } from "./dto/create-course-pack.dto";

@Controller("course-pack")
export class CoursePackController {
  private readonly logger = new Logger(CoursePackController.name);

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
   * 浏览器直传第一步：签发预签名 PUT。
   * 大文件不能走 API 中转（Cloudflare 100s 回源超时，见 README.backend.md）。
   */
  @Post("video/presign")
  presignVideo(@Body() dto: PresignMediaUploadDto) {
    return presignMediaUpload(this.storage, dto.fileName);
  }

  /** 浏览器直传第二步：校验对象后返回入库用的对象键 + 预览 URL */
  @Post("video/from-upload")
  async uploadVideoFromKey(@Body() dto: CompleteMediaUploadDto) {
    const startedAt = Date.now();
    const { key, size } = await verifyUploadedMedia(this.storage, dto.videoKey);
    this.logger.log(
      `[course-pack:video] 直传完成 key=${key} size=${(size / 1024 / 1024).toFixed(2)}MB 校验 ${Date.now() - startedAt}ms`,
    );
    return {
      video: key,
      videoUrl: await this.storage.presignGet(key),
      mediaKind: mediaKindOf(key),
    };
  }

  /**
   * 【旧入口 · 兼容保留】上传本地视频/音频文件到对象存储（不跑 ASR）。
   * 前端已改为 video/presign + video/from-upload 直传；这里只给缓存了旧产物的页面兜底。
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
      limits: { fileSize: MAX_MEDIA_BYTES },
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

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
  Post,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";

import { isAllowedMediaExt, MAX_MEDIA_BYTES, MEDIA_EXT_LABELS } from "../common/media-ext";
import { PresignMediaUploadDto } from "../common/media-upload";
import { UPLOAD_TMP_DIR } from "../common/upload-tmp";
import { CreateForgeJobFromUploadDto } from "./dto/create-forge-job-from-upload.dto";
import { CreateForgeJobDto } from "./dto/create-forge-job.dto";
import { ResolveForgeFailuresDto } from "./dto/resolve-forge-failures.dto";
// 【已停用 · 转录校对】仅 resume 接口使用，该接口已注释保留（见下方 resumeJob 说明）。
// import { ResumeForgeJobDto } from "./dto/resume-forge-job.dto";
import { StartForgeJobDto } from "./dto/start-forge-job.dto";
import { ForgeService } from "./forge.service";

@Controller("forge")
export class ForgeController {
  constructor(private readonly forgeService: ForgeService) {}

  /**
   * 浏览器直传第一步：拿预签名 PUT URL（JSON 请求，秒级返回）。
   * 前端 PUT 到 OSS 成功后，再调 POST forge/jobs/from-upload 建任务。
   */
  @Post("uploads/presign")
  presignUpload(@Body() dto: PresignMediaUploadDto) {
    return this.forgeService.presignUpload(dto.fileName);
  }

  /** 浏览器直传第二步：只带 videoKey 的 JSON，服务端 HeadObject 校验后建任务 */
  @Post("jobs/from-upload")
  createJobFromUpload(@Body() dto: CreateForgeJobFromUploadDto) {
    return this.forgeService.createJobFromUploadedKey(dto);
  }

  /**
   * 【旧入口 · 兼容保留】multipart 上传。
   *
   * 线上 Cloudflare Tunnel 回源有效上行只有 ~47KB/s，请求体必须在 100s 内传完才不会被 524 掐断，
   * 8MB 素材就会失败。前端已改用 uploads/presign + jobs/from-upload 直传 OSS；
   * 这里保留是为了让缓存了旧静态产物的页面仍能工作，新代码不要再用。
   */
  @Post("jobs")
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
  async createJob(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: CreateForgeJobDto,
  ) {
    if (!file) {
      throw new BadRequestException("缺少媒体文件 videoFile");
    }
    return await this.forgeService.createJob(file, dto);
  }

  /** 视频切片流程：defer 上传后提交选中区间并启动转写 */
  @Post("jobs/:id/start")
  startJob(@Param("id") id: string, @Body() dto: StartForgeJobDto) {
    return this.forgeService.startTranscription(id, dto);
  }

  /** 前端轮询：状态 + 完成后附带 course.json + 视频站内 URL */
  @Get("jobs/:id")
  getJob(@Param("id") id: string) {
    return this.forgeService.getJob(id);
  }

  /** 主动取消：杀子进程并标 cancelled；终态调用幂等 */
  @Delete("jobs/:id")
  cancelJob(@Param("id") id: string) {
    return this.forgeService.cancelJob(id);
  }

  /**
   * 【已停用 · 转录校对】转录后人工校对续跑接口，配合 forge.service.resumeJob。
   * 流水线已移除该暂停步骤，接口整段注释保留；恢复步骤见 pipeline-runner.ts 顶部说明。
   */
  /*
  @Post("jobs/:id/resume")
  resumeJob(@Param("id") id: string, @Body() dto: ResumeForgeJobDto) {
    return this.forgeService.resumeJob(id, dto);
  }
  */

  /** 结构化出现失败句后，前端对每个失败句选择「删除 / 重试」并续跑 */
  @Post("jobs/:id/resolve")
  resolveFailures(@Param("id") id: string, @Body() dto: ResolveForgeFailuresDto) {
    return this.forgeService.resolveFailures(id, dto);
  }
}

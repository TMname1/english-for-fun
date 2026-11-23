import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

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

import { CreateForgeJobDto } from "./dto/create-forge-job.dto";
import { ResolveForgeFailuresDto } from "./dto/resolve-forge-failures.dto";
// 【已停用 · 转录校对】仅 resume 接口使用，该接口已注释保留（见下方 resumeJob 说明）。
// import { ResumeForgeJobDto } from "./dto/resume-forge-job.dto";
import { StartForgeJobDto } from "./dto/start-forge-job.dto";
import { ForgeService } from "./forge.service";

/** 与 src/forge/core/forge.ts 的 VIDEO_EXT 白名单保持一致 */
const VIDEO_EXT_WHITELIST = new Set([".mp4", ".m4v", ".mkv", ".webm", ".mov", ".avi"]);
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
/** multer 落盘只是中转，service 上传对象存储后即删 */
const UPLOAD_TMP_DIR = join(tmpdir(), "earthworm-uploads");

@Controller("forge")
export class ForgeController {
  constructor(private readonly forgeService: ForgeService) {}

  /** 接收 multipart 上传 + 启动流水线，返回 jobId；不等待流水线完成 */
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
  async createJob(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: CreateForgeJobDto,
  ) {
    if (!file) {
      throw new BadRequestException("缺少视频文件 videoFile");
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

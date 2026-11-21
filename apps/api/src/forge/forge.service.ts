import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";

import type { CreateForgeJobDto } from "./dto/create-forge-job.dto";
import type { ResumeForgeJobDto } from "./dto/resume-forge-job.dto";
import type { StartForgeJobDto } from "./dto/start-forge-job.dto";
import type { ForgeJobRecord, ForgeJobStage } from "./job-store";
import type { ForgeRunnerHandle } from "./runner-client";
import { StorageService } from "../storage/storage.service";
import { JobStore } from "./job-store";
import { FORGE_OUTPUT_ROOT, spawnForgeRunner } from "./runner-client";

const JOB_TIMEOUT_MS = 30 * 60 * 1000;
/** 单个 clip / 整段转写的音频时长上限，与 course-forge 的 MAX_ASR_SECONDS（百炼 ASR flash 5 分钟）对齐 */
const MAX_CLIP_SECONDS = 300;

/** 流水线可能产出的 JSON 文件；阶段结束时存在的才上传到 forge/<jobId>/ */
const ARTIFACT_FILES = [
  "meta.json",
  "transcript.json",
  "transcript.raw.json",
  "transcript.edited.json",
  "clips.json",
  "alignment.json",
  "course.json",
];

export interface ForgeJobView {
  id: string;
  status: ForgeJobRecord["status"];
  stage: ForgeJobStage;
  message: string;
  error?: string;
  elapsedMs: number;
  outDir: string;
  /** 预签名 URL，前端预览播放用（会过期，不可入库） */
  videoPath: string;
  /** 视频对象键，前端入库时填到 course_packs.video */
  videoKey: string;
  title: string;
  type: "dialogue" | "music";
  language?: string;
  description?: string;
  /** status=awaiting_review 时附带：ASR 转录结果（word 级），供前端校对编辑 */
  transcriptJson?: unknown;
  /** status=done 时附带，结构同 course.json（ForgePayload） */
  courseJson?: unknown;
  /** 视频切片流程：选中的时间区间（秒） */
  clips?: { start: number; end: number }[];
}

@Injectable()
export class ForgeService {
  private readonly logger = new Logger(ForgeService.name);
  private readonly handles = new Map<string, ForgeRunnerHandle>();
  private readonly timeouts = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly store: JobStore,
    private readonly storage: StorageService,
  ) {}

  async createJob(file: Express.Multer.File, dto: CreateForgeJobDto): Promise<{ jobId: string }> {
    const videoKey = `course-video/${file.filename}`;
    try {
      await this.storage.uploadFile(videoKey, file.path);
    } finally {
      await rm(file.path, { force: true }).catch(() => {});
    }

    // 全局 ValidationPipe 未开 transform，multipart 布尔字段到达时仍是字符串
    const defer = String(dto.defer) === "true";
    const record = this.buildRecord({
      fileName: file.filename,
      title: dto.title,
      type: dto.type,
      language: dto.language,
      desc: dto.desc,
      defer,
    });

    if (!defer) {
      void this.launchTranscribe(record);
    }

    return { jobId: record.id };
  }

  /**
   * B 站下载完成（视频已上传到对象存储）后建一个 defer 流水线任务，
   * 等待前端进入切片页选择切点。
   */
  createJobFromUploadedVideo(params: {
    fileName: string;
    title: string;
    type: "dialogue" | "music";
    language?: string;
    desc?: string;
  }): { jobId: string } {
    const record = this.buildRecord({
      fileName: params.fileName,
      title: params.title,
      type: params.type,
      language: params.language,
      desc: params.desc,
      defer: true,
      pendingMessage: "已下载，等待选择切点",
    });
    return { jobId: record.id };
  }

  private buildRecord(input: {
    fileName: string;
    title: string;
    type: "dialogue" | "music";
    language?: string;
    desc?: string;
    defer: boolean;
    pendingMessage?: string;
  }): ForgeJobRecord {
    const jobId = input.fileName.replace(/\.[^.]+$/, "");
    const outDir = join(FORGE_OUTPUT_ROOT, jobId);

    const record: ForgeJobRecord = {
      id: jobId,
      status: input.defer ? "pending" : "running",
      stage: "pending",
      message: input.defer ? input.pendingMessage ?? "已上传，等待选择切点" : "流水线启动中…",
      startedAt: Date.now(),
      outDir,
      videoKey: `course-video/${input.fileName}`,
      title: input.title,
      type: input.type,
      language: input.language ?? "en",
      description: input.desc,
      phase: "transcribe",
    };
    this.store.create(record);
    return record;
  }

  /** defer 上传后提交切点并启动转写；clips 缺省转写整段 */
  startTranscription(id: string, dto: StartForgeJobDto): { jobId: string } {
    const record = this.store.get(id);
    if (!record) throw new NotFoundException(`未找到任务 ${id}`);
    if (record.status !== "pending") {
      throw new BadRequestException(`任务 ${id} 当前状态 ${record.status}，无法启动转写`);
    }

    const clips = dto.clips;
    if (clips) {
      if (clips.length === 0) {
        throw new BadRequestException("clips 不能为空数组；转写整段请省略该字段");
      }
      for (let i = 0; i < clips.length; i++) {
        const c = clips[i];
        if (c.end - c.start < 0.1) {
          throw new BadRequestException(`第 ${i + 1} 个 clip 时长不足 0.1 秒`);
        }
        if (c.end - c.start > MAX_CLIP_SECONDS) {
          throw new BadRequestException(
            `第 ${i + 1} 个 clip 超过 5 分钟上限，请继续切分缩短后再提交`,
          );
        }
        if (i > 0 && c.start < clips[i - 1].end) {
          throw new BadRequestException("clips 必须按时间升序且互不重叠");
        }
      }
    }

    const updated = this.store.update(id, {
      status: "running",
      message: "流水线启动中…",
      startedAt: Date.now(),
      clips,
    })!;
    void this.launchTranscribe(updated);
    return { jobId: id };
  }

  /** ffmpeg 需要本地文件：先把视频从对象存储拉到临时工作区，再起跑流水线子进程 */
  private async launchTranscribe(record: ForgeJobRecord): Promise<void> {
    try {
      await mkdir(record.outDir, { recursive: true });
      const mediaPath = join(record.outDir, `source${extname(record.videoKey)}`);
      await this.storage.downloadToFile(record.videoKey, mediaPath);

      const handle = spawnForgeRunner(
        {
          phase: "transcribe",
          mediaPath,
          title: record.title,
          type: record.type,
          description: record.description,
          language: record.language,
          outDir: record.outDir,
          clips: record.clips,
        },
        {
          onStage: (stage) => this.handleStage(record.id, stage),
          onDone: () => void this.handleDone(record.id),
          onError: (msg) => this.handleError(record.id, msg),
        },
      );
      this.handles.set(record.id, handle);
      // 多 clip 长视频：在 30 分钟基础上按选中总时长放宽（约允许 1x 实时转写余量）
      const selectedMs = (record.clips ?? []).reduce((sum, c) => sum + (c.end - c.start) * 1000, 0);
      this.timeouts.set(
        record.id,
        setTimeout(() => this.handleTimeout(record.id), JOB_TIMEOUT_MS + selectedMs),
      );
    } catch (error) {
      this.handleError(record.id, `准备转写失败：${(error as Error)?.message ?? error}`);
    }
  }

  async getJob(id: string): Promise<ForgeJobView> {
    const record = this.store.get(id);
    if (!record) throw new NotFoundException(`未找到任务 ${id}`);

    const view: ForgeJobView = {
      id: record.id,
      status: record.status,
      stage: record.stage,
      message: record.message,
      error: record.error,
      elapsedMs: (record.finishedAt ?? Date.now()) - record.startedAt,
      outDir: record.outDir,
      videoPath: await this.storage.presignGet(record.videoKey),
      videoKey: record.videoKey,
      title: record.title,
      type: record.type,
      language: record.language,
      description: record.description,
      clips: record.clips,
    };

    if (record.status === "awaiting_review") {
      const text = await this.storage.getBuffer(`forge/${id}/transcript.json`);
      if (text) {
        view.transcriptJson = JSON.parse(text.toString("utf-8"));
      }
    }

    if (record.status === "done") {
      const text = await this.storage.getBuffer(`forge/${id}/course.json`);
      if (text) {
        view.courseJson = JSON.parse(text.toString("utf-8"));
      }
    }
    return view;
  }

  /**
   * 校对后续跑：edited transcript 写对象存储，拉回产物到新的临时工作区，起 structure 阶段子进程。
   * word 级编辑（改文字/删整段，不增删词、不改时间）由 course-forge 在子进程内规整为 Transcript。
   */
  async resumeJob(id: string, dto: ResumeForgeJobDto): Promise<{ jobId: string }> {
    const record = this.store.get(id);
    if (!record) throw new NotFoundException(`未找到任务 ${id}`);
    if (record.status !== "awaiting_review") {
      throw new BadRequestException(`任务 ${id} 当前状态 ${record.status}，无法继续`);
    }
    if (!Array.isArray(dto?.segments) || dto.segments.length === 0) {
      throw new BadRequestException("校对的转录分段不能为空");
    }

    const editedJson = `${JSON.stringify({ segments: dto.segments }, null, 2)}\n`;
    await this.storage.putBuffer(
      `forge/${id}/transcript.edited.json`,
      Buffer.from(editedJson, "utf-8"),
      "application/json",
    );

    // structure 子进程仍操作本地文件：把持久产物拉回临时工作区
    await mkdir(record.outDir, { recursive: true });
    for (const name of ["meta.json", "transcript.json", "clips.json", "transcript.edited.json"]) {
      const buf = await this.storage.getBuffer(`forge/${id}/${name}`);
      if (buf) {
        await writeFile(join(record.outDir, name), buf);
      }
    }

    this.store.update(id, {
      status: "running",
      stage: "structuring",
      message: "按校对结果继续：LLM 结构化中…",
      phase: "structure",
    });

    const handle = spawnForgeRunner(
      {
        phase: "structure",
        language: record.language,
        outDir: record.outDir,
      },
      {
        onStage: (stage) => this.handleStage(id, stage),
        onDone: () => void this.handleDone(id),
        onError: (msg) => this.handleError(id, msg),
      },
    );
    this.handles.set(id, handle);
    this.timeouts.set(
      id,
      setTimeout(() => this.handleTimeout(id), JOB_TIMEOUT_MS),
    );

    return { jobId: id };
  }

  cancelJob(id: string): { cancelled: boolean } {
    const record = this.store.get(id);
    if (!record) throw new NotFoundException(`未找到任务 ${id}`);
    if (
      record.status !== "running" &&
      record.status !== "pending" &&
      record.status !== "awaiting_review"
    ) {
      return { cancelled: false };
    }
    this.handles.get(id)?.kill();
    this.handles.delete(id);
    this.clearTimers(id);
    this.cleanupScratch(record);
    this.store.update(id, {
      status: "cancelled",
      message: "已取消",
      finishedAt: Date.now(),
    });
    return { cancelled: true };
  }

  private handleStage(id: string, stage: ForgeJobStage): void {
    const record = this.store.get(id);
    if (!record || record.status !== "running") return;
    this.store.update(id, { stage, message: stageMessage(stage) });
  }

  private async handleDone(id: string): Promise<void> {
    const record = this.store.get(id);
    if (!record || record.status !== "running") return;

    try {
      await this.uploadArtifacts(record);
    } catch (error) {
      this.handleError(id, `产物上传对象存储失败：${(error as Error)?.message ?? error}`);
      return;
    }
    this.cleanupScratch(record);
    this.clearTimers(id);
    this.handles.delete(id);

    // 第一段（转录）完成 → 暂停等待人工校对，不进 done
    if (record.phase === "transcribe") {
      this.store.update(id, {
        status: "awaiting_review",
        stage: "transcribed",
        message: "转录完成，等待校对",
      });
      return;
    }

    this.store.update(id, {
      status: "done",
      stage: "done",
      message: "已完成",
      finishedAt: Date.now(),
    });
  }

  /** 把本地临时工作区里存在的 JSON 产物上传到 forge/<jobId>/ */
  private async uploadArtifacts(record: ForgeJobRecord): Promise<void> {
    for (const name of ARTIFACT_FILES) {
      const local = join(record.outDir, name);
      if (!existsSync(local)) continue;
      const buf = await readFile(local);
      await this.storage.putBuffer(`forge/${record.id}/${name}`, buf, "application/json");
    }
  }

  private cleanupScratch(record: ForgeJobRecord): void {
    void rm(record.outDir, { recursive: true, force: true }).catch((error) => {
      this.logger.warn(`清理临时工作区失败 ${record.outDir}: ${error}`);
    });
  }

  private handleError(id: string, message: string): void {
    const record = this.store.get(id);
    if (!record) return;
    if (record.status !== "running" && record.status !== "pending") return;
    this.clearTimers(id);
    this.cleanupScratch(record);
    this.store.update(id, {
      status: "failed",
      message: "失败",
      error: message,
      finishedAt: Date.now(),
    });
    this.handles.delete(id);
  }

  private handleTimeout(id: string): void {
    const record = this.store.get(id);
    if (!record || record.status !== "running") return;
    this.handles.get(id)?.kill();
    this.handleError(id, "流水线超过 30 分钟未完成，已强制终止");
  }

  private clearTimers(id: string): void {
    const t = this.timeouts.get(id);
    if (t) {
      clearTimeout(t);
      this.timeouts.delete(id);
    }
  }
}

function stageMessage(stage: ForgeJobStage): string {
  switch (stage) {
    case "pending":
      return "准备中…";
    case "transcoding":
      return "音频提取中…";
    case "transcribing":
      return "ASR 转写中…";
    case "transcribed":
      return "转录完成，等待校对";
    case "structuring":
      return "LLM 结构化中…";
    case "aligning":
      return "时间戳对齐中…";
    case "done":
      return "已完成";
    default:
      return "处理中…";
  }
}

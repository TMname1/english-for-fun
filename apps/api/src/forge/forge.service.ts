import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";

import type { CreateForgeJobDto } from "./dto/create-forge-job.dto";
import type { ForgeJobRecord, ForgeJobStage } from "./job-store";
import type { ForgeRunnerHandle } from "./runner-client";
import { JobStore } from "./job-store";
import { COURSE_VIDEO_DIR, FORGE_OUTPUT_ROOT, spawnForgeRunner } from "./runner-client";

const JOB_TIMEOUT_MS = 30 * 60 * 1000;

export interface ForgeJobView {
  id: string;
  status: ForgeJobRecord["status"];
  stage: ForgeJobStage;
  message: string;
  error?: string;
  elapsedMs: number;
  outDir: string;
  /** 站内 URL，前端预览/入库时填到 course_packs.video */
  videoPath: string;
  title: string;
  type: "dialogue" | "music";
  language?: string;
  description?: string;
  /** 仅在 status=done 时附带，结构同 course.json（ForgePayload） */
  courseJson?: unknown;
}

@Injectable()
export class ForgeService {
  private readonly handles = new Map<string, ForgeRunnerHandle>();
  private readonly timeouts = new Map<string, NodeJS.Timeout>();

  constructor(private readonly store: JobStore) {}

  createJob(file: Express.Multer.File, dto: CreateForgeJobDto): { jobId: string } {
    const jobId = file.filename.replace(/\.[^.]+$/, "");
    const videoFsPath = join(COURSE_VIDEO_DIR, file.filename);
    const videoUrlPath = `/course-video/${file.filename}`;
    const outDir = join(FORGE_OUTPUT_ROOT, jobId);

    const record: ForgeJobRecord = {
      id: jobId,
      status: "running",
      stage: "pending",
      message: "流水线启动中…",
      startedAt: Date.now(),
      outDir,
      videoFsPath,
      videoUrlPath,
      title: dto.title,
      type: dto.type,
      language: dto.language ?? "en",
      description: dto.desc,
    };
    this.store.create(record);

    const handle = spawnForgeRunner(
      {
        mediaPath: videoFsPath,
        title: dto.title,
        type: dto.type,
        description: dto.desc,
        language: dto.language,
        outDir,
      },
      {
        onStage: (stage) => this.handleStage(jobId, stage),
        onDone: () => this.handleDone(jobId),
        onError: (msg) => this.handleError(jobId, msg),
      },
    );
    this.handles.set(jobId, handle);
    this.timeouts.set(
      jobId,
      setTimeout(() => this.handleTimeout(jobId), JOB_TIMEOUT_MS),
    );

    return { jobId };
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
      videoPath: record.videoUrlPath,
      title: record.title,
      type: record.type,
      language: record.language,
      description: record.description,
    };

    if (record.status === "done") {
      try {
        const text = await readFile(join(record.outDir, "course.json"), "utf-8");
        view.courseJson = JSON.parse(text);
      } catch {
        // 产物缺失时不阻断轮询，前端保持 done 状态即可
      }
    }
    return view;
  }

  cancelJob(id: string): { cancelled: boolean } {
    const record = this.store.get(id);
    if (!record) throw new NotFoundException(`未找到任务 ${id}`);
    if (record.status !== "running" && record.status !== "pending") {
      return { cancelled: false };
    }
    this.handles.get(id)?.kill();
    this.handles.delete(id);
    this.clearTimers(id);
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

  private handleDone(id: string): void {
    const record = this.store.get(id);
    if (!record || record.status !== "running") return;
    this.clearTimers(id);
    this.store.update(id, {
      status: "done",
      stage: "done",
      message: "已完成",
      finishedAt: Date.now(),
    });
    this.handles.delete(id);
  }

  private handleError(id: string, message: string): void {
    const record = this.store.get(id);
    if (!record) return;
    if (record.status !== "running" && record.status !== "pending") return;
    this.clearTimers(id);
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

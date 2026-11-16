import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";

import type { CreateForgeJobDto } from "./dto/create-forge-job.dto";
import type { ResumeForgeJobDto } from "./dto/resume-forge-job.dto";
import type { StartForgeJobDto } from "./dto/start-forge-job.dto";
import type { ForgeJobRecord, ForgeJobStage } from "./job-store";
import type { ForgeRunnerHandle } from "./runner-client";
import { JobStore } from "./job-store";
import { COURSE_VIDEO_DIR, FORGE_OUTPUT_ROOT, spawnForgeRunner } from "./runner-client";

const JOB_TIMEOUT_MS = 30 * 60 * 1000;
/** 单个 clip / 整段转写的音频时长上限，与 course-forge 的 MAX_ASR_SECONDS（百炼 ASR flash 5 分钟）对齐 */
const MAX_CLIP_SECONDS = 300;

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
  /** status=awaiting_review 时附带：ASR 转录结果（word 级），供前端校对编辑 */
  transcriptJson?: unknown;
  /** status=done 时附带，结构同 course.json（ForgePayload） */
  courseJson?: unknown;
  /** 视频切片流程：选中的时间区间（秒） */
  clips?: { start: number; end: number }[];
}

@Injectable()
export class ForgeService {
  private readonly handles = new Map<string, ForgeRunnerHandle>();
  private readonly timeouts = new Map<string, NodeJS.Timeout>();

  constructor(private readonly store: JobStore) {}

  createJob(file: Express.Multer.File, dto: CreateForgeJobDto): { jobId: string } {
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
      this.launchTranscribe(record);
    }

    return { jobId: record.id };
  }

  /**
   * B 站下载完成后，用已在服务器落盘的视频文件建一个 defer 流水线任务（等待前端进入切片页选择切点）。
   * 文件名需已落在 COURSE_VIDEO_DIR 下。
   */
  createJobFromLocalVideo(params: {
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
    const videoFsPath = join(COURSE_VIDEO_DIR, input.fileName);
    const videoUrlPath = `/course-video/${input.fileName}`;
    const outDir = join(FORGE_OUTPUT_ROOT, jobId);

    const record: ForgeJobRecord = {
      id: jobId,
      status: input.defer ? "pending" : "running",
      stage: "pending",
      message: input.defer ? input.pendingMessage ?? "已上传，等待选择切点" : "流水线启动中…",
      startedAt: Date.now(),
      outDir,
      videoFsPath,
      videoUrlPath,
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
    this.launchTranscribe(updated);
    return { jobId: id };
  }

  private launchTranscribe(record: ForgeJobRecord): void {
    const handle = spawnForgeRunner(
      {
        phase: "transcribe",
        mediaPath: record.videoFsPath,
        title: record.title,
        type: record.type,
        description: record.description,
        language: record.language,
        outDir: record.outDir,
        clips: record.clips,
      },
      {
        onStage: (stage) => this.handleStage(record.id, stage),
        onDone: () => this.handleDone(record.id),
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
      clips: record.clips,
    };

    if (record.status === "awaiting_review") {
      try {
        const text = await readFile(join(record.outDir, "transcript.json"), "utf-8");
        view.transcriptJson = JSON.parse(text);
      } catch {
        // transcript 缺失时不阻断轮询，前端保持 awaiting_review 状态即可
      }
    }

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

  /**
   * 校对后续跑：校验状态、落 transcript.edited.json、起 structure 阶段子进程。
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

    await writeFile(
      join(record.outDir, "transcript.edited.json"),
      `${JSON.stringify({ segments: dto.segments }, null, 2)}\n`,
      "utf-8",
    );

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
        onDone: () => this.handleDone(id),
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

    // 第一段（转录）完成 → 暂停等待人工校对，不进 done
    if (record.phase === "transcribe") {
      this.clearTimers(id);
      this.handles.delete(id);
      this.store.update(id, {
        status: "awaiting_review",
        stage: "transcribed",
        message: "转录完成，等待校对",
      });
      return;
    }

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

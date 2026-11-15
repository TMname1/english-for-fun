import { Injectable, OnModuleDestroy } from "@nestjs/common";

export type ForgeJobStatus =
  | "pending"
  | "running"
  | "awaiting_review"
  | "done"
  | "failed"
  | "cancelled";

export type ForgeJobStage =
  | "pending"
  | "transcoding"
  | "transcribing"
  | "transcribed"
  | "structuring"
  | "aligning"
  | "done";

export type ForgePhase = "transcribe" | "structure";

export interface ForgeJobRecord {
  id: string;
  status: ForgeJobStatus;
  stage: ForgeJobStage;
  message: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  /** 流水线产物目录（course.json / meta.json / alignment.json 所在处） */
  outDir: string;
  /** 视频文件在服务器上的绝对路径，runner 内 ffmpeg 直接读取 */
  videoFsPath: string;
  /** 静态挂载后的站内 URL，如 /course-video/xxx.mp4 */
  videoUrlPath: string;
  /** 标题 / 类型，前端轮询回显用 */
  title: string;
  type: "dialogue" | "music";
  language?: string;
  description?: string;
  /** 两段式流程当前所处阶段：transcribe（转录后暂停）/ structure（校对后续跑） */
  phase: ForgePhase;
}

const STALE_AFTER_MS = 4 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;

@Injectable()
export class JobStore implements OnModuleDestroy {
  private readonly records = new Map<string, ForgeJobRecord>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanupStale(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
  }

  onModuleDestroy() {
    clearInterval(this.cleanupTimer);
  }

  create(record: ForgeJobRecord): void {
    this.records.set(record.id, record);
  }

  get(id: string): ForgeJobRecord | undefined {
    return this.records.get(id);
  }

  update(id: string, patch: Partial<ForgeJobRecord>): ForgeJobRecord | undefined {
    const current = this.records.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.records.set(id, next);
    return next;
  }

  /** 已结束（done/failed/cancelled）的记录若超过 4 小时则清除，dev 场景足够 */
  private cleanupStale(): void {
    const now = Date.now();
    for (const [id, record] of this.records) {
      if (record.status === "pending" || record.status === "running") continue;
      if (record.finishedAt && now - record.finishedAt > STALE_AFTER_MS) {
        this.records.delete(id);
      }
    }
  }
}

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { toDataURL } from "qrcode";

import type { DbType } from "../global/providers/db.provider";
import type { BilidownCore, BiliInfo, BiliLoginStatus, BiliPollResult } from "./bilidown-bridge";
import type { DownloadBiliDto } from "./dto/download-bili.dto";
import { ForgeService } from "../forge/forge.service";
import { DB } from "../global/providers/db.provider";
import { StorageService } from "../storage/storage.service";
import { createDbCookieStore } from "./bili-cookie.store";
import { getBilidownCore } from "./bilidown-bridge";

type DownloadStatus = "running" | "done" | "failed" | "cancelled";

export interface BiliDownloadRecord {
  id: string;
  status: DownloadStatus;
  phase: string;
  downloaded: number;
  total: number;
  percent: number;
  jobId?: string;
  videoPath?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

/** 阶段英文码 → 中文提示 */
const PHASE_LABEL: Record<string, string> = {
  parse: "解析视频信息…",
  video: "下载视频流…",
  audio: "下载音频流…",
  mux: "混流封装 MP4…",
  done: "完成",
};

/** 同时进行的 B 站下载上限，超出的请求直接拒绝，避免打满带宽与磁盘 */
const MAX_CONCURRENT_DOWNLOADS = 3;
/** 终态下载记录保留时长，超时后清理 */
const RECORD_TTL_MS = 60 * 60 * 1000;
/** 扫码登录会话保留时长 */
const LOGIN_SESSION_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class BiliService {
  private readonly logger = new Logger(BiliService.name);
  private readonly downloads = new Map<string, BiliDownloadRecord>();
  /** 进行中的下载取消控制器 */
  private readonly controllers = new Map<string, AbortController>();
  /** 扫码登录会话：qrcodeKey → 轮询用的 cookie jar + 创建时间（B 站二维码约 180s 过期） */
  private readonly pendingLogins = new Map<
    string,
    { jar: Record<string, string>; createdAt: number }
  >();

  constructor(
    @Inject(DB) private readonly db: DbType,
    private readonly forgeService: ForgeService,
    private readonly storage: StorageService,
  ) {}

  /** 内核为单例；首次取用时把数据库 cookie store 注入进去，之后所有读写走 bili_cookie 表。 */
  private corePromise: Promise<BilidownCore> | null = null;
  private core(): Promise<BilidownCore> {
    if (!this.corePromise) {
      this.corePromise = getBilidownCore().then((c) => {
        c.configureCookieStore(createDbCookieStore(this.db));
        return c;
      });
    }
    return this.corePromise;
  }

  async loginStatus(): Promise<BiliLoginStatus> {
    const core = await this.core();
    return core.getLoginStatus();
  }

  /** 生成登录二维码：返回可直接放进 <img> 的 data URL 与轮询 key */
  async loginStart(): Promise<{ key: string; qrDataUrl: string }> {
    const core = await this.core();
    const { url, qrcodeKey, jar } = await core.createLoginQrcode();
    this.pendingLogins.set(qrcodeKey, { jar, createdAt: Date.now() });
    const qrDataUrl = await toDataURL(url, { width: 240, margin: 1 });
    return { key: qrcodeKey, qrDataUrl };
  }

  /** 轮询登录状态；成功时由内核落盘 cookie 并返回账号信息 */
  async loginPoll(key: string): Promise<{
    status: "pending" | "scanned" | "expired" | "success";
    uname?: string;
    vipStatus?: boolean;
  }> {
    const core = await this.core();
    const session = this.pendingLogins.get(key);
    if (!session) throw new NotFoundException("登录会话已失效，请重新获取二维码");
    const r: BiliPollResult = await core.pollLogin(key, session.jar);
    if (r.status === "success") {
      this.pendingLogins.delete(key);
      return { status: "success", uname: r.uname, vipStatus: r.vipStatus };
    }
    if (r.status === "86038") {
      this.pendingLogins.delete(key);
      return { status: "expired" };
    }
    return { status: r.status === "86090" ? "scanned" : "pending" };
  }

  async info(url: string): Promise<BiliInfo> {
    if (!url?.trim()) throw new BadRequestException("请输入 B 站视频链接或 BV 号");
    const core = await this.core();
    try {
      return await core.getInfo(url);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`解析 B 站视频信息失败：${msg}`);
      // 内核抛的是普通 Error，不包装的话 Nest 一律兜底成 500，前端看不到真实原因
      if (msg.includes("无法从")) throw new BadRequestException(msg);
      if (msg.includes("HTTP 412")) {
        throw new BadGatewayException("被 B 站风控拦截（HTTP 412），请稍后重试或重新扫码登录");
      }
      throw new BadGatewayException(`解析失败：${msg}`);
    }
  }

  /** 启动一次后台下载，立即返回 downloadId；完成后建 defer 流水线任务 */
  startDownload(dto: DownloadBiliDto): { downloadId: string } {
    this.cleanupStaleRecords();
    const active = [...this.downloads.values()].filter((d) => d.status === "running");
    if (active.length >= MAX_CONCURRENT_DOWNLOADS) {
      throw new BadRequestException("下载通道繁忙，请等待当前下载完成后再试");
    }

    const id = randomUUID();
    const fileName = `${id}.mp4`;
    const record: BiliDownloadRecord = {
      id,
      status: "running",
      phase: PHASE_LABEL.parse,
      downloaded: 0,
      total: 0,
      percent: 0,
      startedAt: Date.now(),
    };
    this.downloads.set(id, record);

    const controller = new AbortController();
    this.controllers.set(id, controller);
    void this.runDownload(id, dto, fileName, controller.signal).finally(() =>
      this.controllers.delete(id),
    );

    return { downloadId: id };
  }

  private async runDownload(
    id: string,
    dto: DownloadBiliDto,
    fileName: string,
    signal: AbortSignal,
  ): Promise<void> {
    const record = this.downloads.get(id)!;
    // ffmpeg 混流必须操作本地文件：先落到临时目录，成品上传对象存储后清理
    const workDir = join(tmpdir(), "earthworm-bili", id);
    const videoKey = `course-video/${fileName}`;
    let uploaded = false;
    try {
      const core = await this.core();
      await core.download({
        input: dto.url,
        p: dto.p,
        qn: dto.qn,
        outDir: workDir,
        outName: fileName,
        signal,
        onStage: (stage) => {
          record.phase = PHASE_LABEL[stage] ?? stage;
        },
        onProgress: ({ downloaded, total }) => {
          record.downloaded = downloaded;
          record.total = total;
          record.percent = total ? Math.min(1, downloaded / total) : 0;
        },
        onLog: (msg, level) => this.logger[level === "warn" ? "warn" : "log"](msg),
      });

      await this.storage.uploadFile(videoKey, join(workDir, fileName));
      uploaded = true;

      const { jobId } = this.forgeService.createJobFromUploadedVideo({
        fileName,
        title: dto.title,
        type: dto.type,
        language: dto.language,
        desc: dto.desc,
      });
      record.status = "done";
      record.phase = PHASE_LABEL.done;
      record.percent = 1;
      record.jobId = jobId;
      record.videoPath = await this.storage.presignGet(videoKey);
      record.finishedAt = Date.now();
    } catch (error) {
      if (uploaded) {
        await this.storage.deleteObject(videoKey).catch(() => {});
      }
      record.status = signal.aborted ? "cancelled" : "failed";
      record.error = error instanceof Error ? error.message : String(error);
      record.finishedAt = Date.now();
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  getDownload(id: string): BiliDownloadRecord {
    const record = this.downloads.get(id);
    if (!record) throw new NotFoundException(`未找到下载任务 ${id}`);
    return record;
  }

  cancelDownload(id: string): { cancelled: boolean } {
    const record = this.downloads.get(id);
    if (!record) throw new NotFoundException(`未找到下载任务 ${id}`);
    if (record.status !== "running") return { cancelled: false };
    this.controllers.get(id)?.abort();
    return { cancelled: true };
  }

  private cleanupStaleRecords(): void {
    const now = Date.now();
    for (const [id, record] of this.downloads) {
      if (record.status === "running") continue;
      if (record.finishedAt && now - record.finishedAt > RECORD_TTL_MS) {
        this.downloads.delete(id);
      }
    }
    for (const [key, session] of this.pendingLogins) {
      // 登录二维码有效期约 180s，超过 5 分钟仍未完成的会话直接丢弃
      if (now - session.createdAt > LOGIN_SESSION_TTL_MS) this.pendingLogins.delete(key);
    }
  }
}

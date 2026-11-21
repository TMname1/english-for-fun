import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { asc, eq } from "drizzle-orm";

import type { CreateCoursePack } from "@earthworm/game-data-sdk";
import {
  createCoursePack,
  deleteCoursePack,
  setupGameDataSDK,
  updateCoursePack,
} from "@earthworm/game-data-sdk";
import { coursePack, statement } from "@earthworm/schema";
import type { CreateCoursePackDto } from "./dto/create-course-pack.dto";
import { CourseHistoryService } from "../course-history/course-history.service";
import { DB, DbType } from "../global/providers/db.provider";
import { StorageService } from "../storage/storage.service";
import { UserCourseProgressService } from "../user-course-progress/user-course-progress.service";

@Injectable()
export class CoursePackService {
  private readonly logger = new Logger(CoursePackService.name);
  private gameDataSdkReady = false;

  constructor(
    @Inject(DB) private db: DbType,
    private readonly courseHistoryService: CourseHistoryService,
    private readonly userCourseProgressService: UserCourseProgressService,
    private readonly configService: ConfigService,
    private readonly storage: StorageService,
  ) {}

  async findAll() {
    return await this.db.query.coursePack.findMany({
      orderBy: asc(coursePack.order),
    });
  }

  async findOne(coursePackId: string) {
    const result = await this.db.query.coursePack.findFirst({
      where: eq(coursePack.id, coursePackId),
    });

    if (!result) {
      throw new NotFoundException(`CoursePack with ID ${coursePackId} not found`);
    }

    return result;
  }

  /**
   * 课程包详情：pack 信息 + 完成次数（原 courses 数组随"分课程"功能删除）。
   * 播放路径：video 对象键转预签名 URL（外部 URL 透传）。
   */
  async findOneWithCompletion(coursePackId: string) {
    const pack = await this.findOne(coursePackId);
    const completionCount = await this.courseHistoryService.findCompletionCount(coursePackId);

    return {
      ...pack,
      video: await this.storage.presignVideoUrl(pack.video),
      videoIsExternal: /^https?:\/\//i.test(pack.video ?? ""),
      completionCount,
    };
  }

  /**
   * 学习内容：课程包内唯一课程的 statements（按 order 排序，不带 id）+ 用户当前进度。
   */
  async findLearning(coursePackId: string) {
    const pack = await this.findOne(coursePackId);

    const statements = await this.db.query.statement.findMany({
      where: eq(statement.coursePackId, coursePackId),
      columns: {
        id: false,
      },
      orderBy: [asc(statement.order)],
    });

    const statementIndex = await this.userCourseProgressService.findStatement(coursePackId);

    return {
      ...pack,
      video: await this.storage.presignVideoUrl(pack.video),
      videoIsExternal: /^https?:\/\//i.test(pack.video ?? ""),
      statements,
      statementIndex,
    };
  }

  /**
   * 编辑用详情：课程包元信息（含 video）+ 句子（含 startTime/endTime，规范成 { english, chinese, phonetic }）。
   * 不含用户进度，供「修改课程」表单预填。
   */
  async findForEdit(coursePackId: string) {
    const pack = await this.findOne(coursePackId);

    const rows = await this.db.query.statement.findMany({
      where: eq(statement.coursePackId, coursePackId),
      columns: {
        english: true,
        chinese: true,
        soundmark: true,
        startTime: true,
        endTime: true,
      },
      orderBy: [asc(statement.order)],
    });

    return {
      title: pack.title,
      description: pack.description ?? "",
      cover: pack.cover ?? "",
      video: pack.video ?? "",
      statements: rows.map((row) => ({
        english: row.english,
        chinese: row.chinese,
        phonetic: row.soundmark,
        startTime: row.startTime ?? undefined,
        endTime: row.endTime ?? undefined,
      })),
    };
  }

  /**
   * 完成一次课程学习：累计课程包的 completionCount。
   */
  async completeCoursePack(coursePackId: string) {
    await this.findOne(coursePackId);

    return await this.courseHistoryService.upsert(coursePackId);
  }

  /**
   * 通过 game-data-sdk 创建课程包（含单一课程与句子），一次性事务写入。
   */
  async create(coursePackInfo: CreateCoursePackDto) {
    this.ensureGameDataSdk();

    const payload: CreateCoursePack = {
      title: coursePackInfo.title,
      description: coursePackInfo.description ?? "",
      cover: coursePackInfo.cover ?? "",
      video: coursePackInfo.video ?? "",
      courses: {
        title: coursePackInfo.courses.title,
        description: coursePackInfo.courses.description ?? "",
        statements: coursePackInfo.courses.statements.map((statement) => ({
          english: statement.english,
          chinese: statement.chinese,
          phonetic: statement.phonetic ?? "",
          startTime: statement.startTime ?? null,
          endTime: statement.endTime ?? null,
          words: statement.words ?? null,
        })),
      },
    };

    return await createCoursePack(payload);
  }

  /**
   * 删除课程包（级联删除其下句子及学习记录、进度），并清理对象存储中的孤儿文件。
   */
  async delete(coursePackId: string) {
    this.ensureGameDataSdk();

    // 先走 API 层查询，保证不存在时返回 404 而不是 SDK 内部的 500
    const pack = await this.findOne(coursePackId);

    await deleteCoursePack(coursePackId);

    await this.cleanupVideoObjects(pack.video, coursePackId);

    return { deleted: true, coursePackId };
  }

  /**
   * 视频对象键被最后一个引用的包删除时才删对象及对应 forge 产物；
   * 清理失败不影响删除结果（数据库是事实来源），仅告警。
   */
  private async cleanupVideoObjects(video: string | null | undefined, coursePackId: string) {
    const key = video?.trim();
    if (!key || /^https?:\/\//i.test(key)) return;

    try {
      const stillReferenced = await this.db.query.coursePack.findFirst({
        where: eq(coursePack.video, key),
        columns: { id: true },
      });
      if (stillReferenced) return;

      await this.storage.deleteObject(key);
      // jobId/runId 即视频文件名去扩展名（forge.service buildRecord 与 forge/core/importer 同规则）
      const forgeId = key
        .split("/")
        .pop()!
        .replace(/\.[^.]+$/, "");
      await this.storage.deleteByPrefix(`forge/${forgeId}/`);
    } catch (error) {
      this.logger.warn(
        `课程包 ${coursePackId} 的对象存储清理失败（${key}）：${(error as Error).message}`,
      );
    }
  }

  /**
   * 更新课程包（元信息 + 重建句子），通过 game-data-sdk 一次性事务写入。
   */
  async update(coursePackId: string, updateCoursePackDto: CreateCoursePackDto) {
    this.ensureGameDataSdk();

    // 先走 API 层查询，保证不存在时返回 404 而不是 SDK 内部的 500
    await this.findOne(coursePackId);

    const payload: CreateCoursePack = {
      title: updateCoursePackDto.title,
      description: updateCoursePackDto.description ?? "",
      cover: updateCoursePackDto.cover ?? "",
      video: updateCoursePackDto.video,
      courses: {
        title: updateCoursePackDto.courses.title,
        description: updateCoursePackDto.courses.description ?? "",
        statements: updateCoursePackDto.courses.statements.map((statement) => ({
          english: statement.english,
          chinese: statement.chinese,
          phonetic: statement.phonetic ?? "",
          startTime: statement.startTime ?? null,
          endTime: statement.endTime ?? null,
          words: statement.words ?? null,
        })),
      },
    };

    return await updateCoursePack(coursePackId, payload);
  }

  // SDK 使用自己的全局连接，只需按当前 DATABASE_URL 初始化一次
  private ensureGameDataSdk() {
    if (this.gameDataSdkReady) return;

    setupGameDataSDK({
      dataBaseURL: this.configService.get<string>("DATABASE_URL") ?? process.env.DATABASE_URL ?? "",
    });
    this.gameDataSdkReady = true;
  }
}

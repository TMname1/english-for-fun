import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { asc, eq, sql } from "drizzle-orm";

import type { CreateCoursePack } from "@earthworm/game-data-sdk";
import {
  createCoursePack,
  deleteCoursePack,
  setupGameDataSDK,
  updateCoursePack,
} from "@earthworm/game-data-sdk";
import { coursePack, statement } from "@earthworm/schema";
import type { CreateCoursePackDto } from "./dto/create-course-pack.dto";
import { mediaKindOf } from "../common/media-ext";
import { CourseHistoryService } from "../course-history/course-history.service";
import { DB, DbType } from "../global/providers/db.provider";
import { StorageService } from "../storage/storage.service";
import { UserCourseProgressService } from "../user-course-progress/user-course-progress.service";

/** 课程目录分页：默认与上限都是 100 条/页（句子很多时避免一次性把全量下发给前端） */
export const DEFAULT_STATEMENTS_PAGE_SIZE = 100;
export const MAX_STATEMENTS_PAGE_SIZE = 100;

export type StatementsFilter = "all" | "mastered" | "notMastered";

export interface StatementsPageQuery {
  page?: string;
  pageSize?: string;
  filter?: string;
}

/** 目录分页查询的原始行（下标是句子在完整有序列表里的位置，跨页唯一） */
type StatementsPageRow = {
  index: number;
  order: number;
  english: string;
  chinese: string;
  soundmark: string;
  start_time: number | null;
  end_time: number | null;
  words: unknown;
  is_mastered: boolean;
};

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
      mediaKind: mediaKindOf(pack.video),
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
      mediaKind: mediaKindOf(pack.video),
      statements,
      statementIndex,
    };
  }

  /**
   * 课程目录分页：仅按需取一页（默认/最多 100 条），服务端按掌握状态筛选。
   *
   * - index 是句子在完整有序列表（order asc）里的下标，跨页唯一，前端据此跳句；
   *   不能用 offset + 页内下标代替，筛选后的列表下标会被压缩。
   * - 掌握状态在服务端关联 mastered_elements 判断（全局已掌握表，忽略大小写），
   *   因此「已掌握/未掌握」筛选也是跨页完整的。
   */
  async findStatementsPage(coursePackId: string, query: StatementsPageQuery = {}) {
    await this.findOne(coursePackId);

    const page = Math.max(1, Number.parseInt(query.page ?? "", 10) || 1);
    const pageSize = Math.min(
      Math.max(1, Number.parseInt(query.pageSize ?? "", 10) || DEFAULT_STATEMENTS_PAGE_SIZE),
      MAX_STATEMENTS_PAGE_SIZE,
    );
    const filter = normalizeStatementsFilter(query.filter);

    // mastered_elements.content 是 jsonb 里的「字符串标量」，而且被 stringify 了两层
    // （服务层 JSON.stringify 一次 + drizzle jsonb 映射再一次），取出来的文本外面还包着一层 JSON 字符串。
    // 这里最多剥两层：既兼容历史上直接存对象/存一层字符串的行，也只在这张表上解析一次并去重，
    // 避免每行句子都去解一遍 jsonb。
    const masteredCte = sql`mastered as (
      select distinct lower(obj ->> 'english') as eng
      from (
        select case
          when jsonb_typeof(lvl1) = 'string' and left(lvl1 #>> '{}', 1) = '{'
            then (lvl1 #>> '{}')::jsonb
          else lvl1
        end as obj
        from (
          select case
            when jsonb_typeof(content) = 'string'
              and left(content #>> '{}', 1) in ('{', '"')
              then (content #>> '{}')::jsonb
            else content
          end as lvl1
          from mastered_elements
        ) unwrapped_once
      ) unwrapped_twice
      where jsonb_typeof(obj) = 'object'
    )`;

    const isMasteredExpr = sql`lower(s.english) in (select eng from mastered where eng is not null)`;

    const queryCte = sql`with ${masteredCte}, ordered as (
      select
        s."order",
        s.english,
        s.chinese,
        s.soundmark,
        s.start_time,
        s.end_time,
        s.words,
        (row_number() over (order by s."order"))::int - 1 as "index",
        ${isMasteredExpr} as is_mastered
      from statements s
      where s.course_pack_id = ${coursePackId}
    )`;

    // 筛选放在 CTE 外层：row_number 必须按完整列表算，index 才不会因筛选被压缩；
    // 外层只能用 CTE 暴露的列，不能引用 CTE 内部的 s.
    const filterCondition =
      filter === "mastered"
        ? sql`is_mastered`
        : filter === "notMastered"
          ? sql`not is_mastered`
          : sql`true`;

    const rows = await this.db.execute<StatementsPageRow>(sql`
      ${queryCte}
      select "index", "order", english, chinese, soundmark, start_time, end_time, words, is_mastered
      from ordered
      where ${filterCondition}
      order by "index"
      limit ${pageSize} offset ${(page - 1) * pageSize}
    `);

    const countRows = await this.db.execute<{ count: number }>(sql`
      ${queryCte}
      select count(*)::int as count from ordered where ${filterCondition}
    `);

    const total = countRows[0]?.count ?? 0;

    return {
      items: rows.map((row) => ({
        index: row.index,
        order: row.order,
        english: row.english,
        chinese: row.chinese,
        soundmark: row.soundmark,
        startTime: row.start_time,
        endTime: row.end_time,
        words: row.words,
        isMastered: row.is_mastered,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
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
      mediaKind: mediaKindOf(pack.video),
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

/** filter 参数归一化：非法值直接 400，避免拼错参数时静默退化成全量 */
function normalizeStatementsFilter(filter: string | undefined): StatementsFilter {
  if (!filter || filter === "all") return "all";
  if (filter === "mastered" || filter === "notMastered") return filter;
  throw new BadRequestException(`不支持的 filter：${filter}（可选 all / mastered / notMastered）`);
}

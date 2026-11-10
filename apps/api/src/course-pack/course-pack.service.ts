import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { asc, eq } from "drizzle-orm";

import type { CreateCoursePack } from "@earthworm/game-data-sdk";
import { createCoursePack, setupGameDataSDK } from "@earthworm/game-data-sdk";
import { course, coursePack } from "@earthworm/schema";
import type { CreateCoursePackDto } from "./dto/create-course-pack.dto";
import { CourseHistoryService } from "../course-history/course-history.service";
import { CourseService } from "../course/course.service";
import { DB, DbType } from "../global/providers/db.provider";

@Injectable()
export class CoursePackService {
  private gameDataSdkReady = false;

  constructor(
    @Inject(DB) private db: DbType,
    private readonly courseService: CourseService,
    private readonly courseHistoryService: CourseHistoryService,
    private readonly configService: ConfigService,
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

  async findOneWithCourses(coursePackId: string) {
    const coursePackWithCourses = await this.findCoursePackWithCourses(coursePackId);

    coursePackWithCourses.courses = await this.addCompletionCountsToCourses(
      coursePackWithCourses.courses,
      coursePackId,
    );

    return coursePackWithCourses;
  }

  private async findCoursePackWithCourses(coursePackId: string) {
    const coursePackWithCourses = await this.db.query.coursePack.findFirst({
      where: eq(coursePack.id, coursePackId),
      with: {
        courses: {
          orderBy: asc(course.order),
        },
      },
    });

    if (!coursePackWithCourses) {
      throw new NotFoundException(`CoursePack with ID ${coursePackId} not found`);
    }

    return coursePackWithCourses;
  }

  private async addCompletionCountsToCourses(courses: any[], coursePackId: string) {
    return await Promise.all(
      courses.map(async (item) => {
        const completionCount = await this.courseHistoryService.findCompletionCount(
          coursePackId,
          item.id,
        );
        return {
          ...item,
          completionCount,
        };
      }),
    );
  }

  async findCourse(coursePackId: string, courseId: string) {
    return await this.courseService.findWithProgress(coursePackId, courseId);
  }

  async findNextCourse(coursePackId: string, courseId: string) {
    return await this.courseService.findNext(coursePackId, courseId);
  }

  async completeCourse(coursePackId: string, courseId: string) {
    return await this.courseService.completeCourse(coursePackId, courseId);
  }

  /**
   * 通过 game-data-sdk 创建课程包（含课程与句子），一次性事务写入。
   */
  async create(coursePackInfo: CreateCoursePackDto) {
    this.ensureGameDataSdk();

    const payload: CreateCoursePack = {
      title: coursePackInfo.title,
      description: coursePackInfo.description ?? "",
      cover: coursePackInfo.cover ?? "",
      courses: coursePackInfo.courses.map((courseInfo) => ({
        title: courseInfo.title,
        description: courseInfo.description ?? "",
        statements: courseInfo.statements.map((statement) => ({
          english: statement.english,
          chinese: statement.chinese,
          phonetic: statement.phonetic ?? "",
        })),
      })),
    };

    return await createCoursePack(payload);
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

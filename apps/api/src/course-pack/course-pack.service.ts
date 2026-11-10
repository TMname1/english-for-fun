import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";

import { course, coursePack } from "@earthworm/schema";
import { CourseHistoryService } from "../course-history/course-history.service";
import { CourseService } from "../course/course.service";
import { DB, DbType } from "../global/providers/db.provider";

@Injectable()
export class CoursePackService {
  constructor(
    @Inject(DB) private db: DbType,
    private readonly courseService: CourseService,
    private readonly courseHistoryService: CourseHistoryService,
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
}

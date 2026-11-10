import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createId } from "@paralleldrive/cuid2";

import type { DbType } from "../../global/providers/db.provider";
import { insertCourse, insertCoursePack } from "../../../test/fixture/db";
import { cleanDB, testImportModules } from "../../../test/helper/utils";
import { endDB } from "../../common/db";
import { CourseHistoryService } from "../../course-history/course-history.service";
import { CourseService } from "../../course/course.service";
import { DB } from "../../global/providers/db.provider";
import { CoursePackService } from "../course-pack.service";

describe("CoursePackService", () => {
  let db: DbType;
  let coursePackService: CoursePackService;
  let courseService: CourseService;

  const fakeCoursePackId = createId();
  const fakeCourseId = createId();

  beforeAll(async () => {
    const testHelper = await setupTesting();
    db = testHelper.db;
    coursePackService = testHelper.coursePackService;
    courseService = testHelper.courseService;
  });

  beforeEach(async () => {
    await cleanDB(db);
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await cleanDB(db);
    await endDB();
  });

  describe("findAll", () => {
    it("should return all course packs", async () => {
      await insertCoursePack(db);
      await insertCoursePack(db, { order: 2, title: "第二个课程包" });

      const result = await coursePackService.findAll();

      expect(result.length).toBe(2);
    });
  });

  describe("findOne", () => {
    it("should return a course pack for a valid ID", async () => {
      const coursePackEntity = await insertCoursePack(db);

      const result = await coursePackService.findOne(coursePackEntity.id);

      expect(result).toEqual(coursePackEntity);
    });

    it("should throw NotFoundException for an invalid ID", async () => {
      await expect(coursePackService.findOne(createId())).rejects.toThrow(NotFoundException);
    });
  });

  describe("findOneWithCourses", () => {
    it("should return a course pack with completion counts", async () => {
      const coursePackEntity = await insertCoursePack(db);
      await insertCourse(db, coursePackEntity.id);

      const result = await coursePackService.findOneWithCourses(coursePackEntity.id);

      expect(result.courses.length).toBe(1);
      expect(result.courses[0]).toHaveProperty("completionCount");
    });

    it("should throw NotFoundException when course pack ID does not exist", async () => {
      await expect(coursePackService.findOneWithCourses("non-existent-id")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("findCourse", () => {
    it("should call courseService.findWithProgress", async () => {
      await coursePackService.findCourse(fakeCoursePackId, fakeCourseId);

      expect(courseService.findWithProgress).toHaveBeenCalledWith(fakeCoursePackId, fakeCourseId);
    });
  });

  describe("findNextCourse", () => {
    it("should call courseService.findNext", async () => {
      await coursePackService.findNextCourse(fakeCoursePackId, fakeCourseId);

      expect(courseService.findNext).toHaveBeenCalled();
    });
  });

  describe("completeCourse", () => {
    it("should call courseService.completeCourse", async () => {
      await coursePackService.completeCourse(fakeCoursePackId, fakeCourseId);

      expect(courseService.completeCourse).toHaveBeenCalledWith(fakeCoursePackId, fakeCourseId);
    });
  });
});

async function setupTesting() {
  const MockCourseService = {
    findWithProgress: jest.fn(),
    find: jest.fn(),
    findNext: jest.fn(),
    completeCourse: jest.fn(),
  };

  const MockCourseHistoryService = {
    findCompletionCount: jest.fn(() => 1),
  };

  const moduleRef = await Test.createTestingModule({
    imports: testImportModules,
    providers: [
      CoursePackService,
      { provide: CourseService, useValue: MockCourseService },
      { provide: CourseHistoryService, useValue: MockCourseHistoryService },
    ],
  }).compile();

  return {
    moduleRef,
    courseService: moduleRef.get<CourseService>(CourseService),
    coursePackService: moduleRef.get<CoursePackService>(CoursePackService),
    db: moduleRef.get<DbType>(DB),
  };
}

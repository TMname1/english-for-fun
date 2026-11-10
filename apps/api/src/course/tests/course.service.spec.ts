import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createId } from "@paralleldrive/cuid2";

import type { DbType } from "../../global/providers/db.provider";
import { insertCourse, insertCoursePack, insertStatement } from "../../../test/fixture/db";
import { cleanDB, testImportModules } from "../../../test/helper/utils";
import { endDB } from "../../common/db";
import { CourseHistoryService } from "../../course-history/course-history.service";
import { DB } from "../../global/providers/db.provider";
import { UserCourseProgressService } from "../../user-course-progress/user-course-progress.service";
import { CourseService } from "../course.service";

describe("course service", () => {
  let db: DbType;
  let courseService: CourseService;
  let courseHistoryService: CourseHistoryService;
  let userCourseProgressService: UserCourseProgressService;

  beforeAll(async () => {
    const testHelper = await setupTesting();
    await cleanDB(testHelper.db);

    db = testHelper.db;
    courseService = testHelper.courseService;
    courseHistoryService = testHelper.courseHistoryService;
    userCourseProgressService = testHelper.userCourseProgressService;
  });

  beforeEach(async () => {
    await cleanDB(db);
  });

  afterAll(async () => {
    await cleanDB(db);
    await endDB();
  });

  afterEach(async () => {
    jest.clearAllMocks();
  });

  describe("find", () => {
    it("should return a course with the given coursePackId and courseId", async () => {
      const { coursePackId, courseEntityFirst } = await setupDBData(db);

      const result = await courseService.find(coursePackId, courseEntityFirst.id);

      expect(result).toHaveProperty("coursePackId");
      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("order");
      expect(result).toHaveProperty("title");
      expect(result).toHaveProperty("statements");
    });

    it("should throw NotFoundException if the course does not exist", async () => {
      await expect(courseService.find(createId(), createId())).rejects.toThrow(NotFoundException);
    });
  });

  describe("findWithProgress", () => {
    it("should return a course with progress information", async () => {
      const { coursePackId, courseEntityFirst } = await setupDBData(db);

      const result = await courseService.findWithProgress(coursePackId, courseEntityFirst.id);

      expect(result).toHaveProperty("statementIndex");
      expect(userCourseProgressService.findStatement).toHaveBeenCalledWith(
        coursePackId,
        courseEntityFirst.id,
      );
    });
  });

  describe("findNext", () => {
    it("should return the next course", async () => {
      const { coursePackId, courseEntityFirst, courseEntitySecond } = await setupDBData(db);

      const result = await courseService.findNext(coursePackId, courseEntityFirst.id);

      expect(result).toEqual(courseEntitySecond);
    });

    it("should throw NotFoundException if there is no next course", async () => {
      const { coursePackId, courseEntitySecond } = await setupDBData(db);

      await expect(courseService.findNext(coursePackId, courseEntitySecond.id)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("completeCourse", () => {
    it("should record completion and return the next course", async () => {
      const { courseEntityFirst, coursePackId } = await setupDBData(db);

      const result = await courseService.completeCourse(coursePackId, courseEntityFirst.id);

      expect(result).toHaveProperty("nextCourse");
      expect(courseHistoryService.upsert).toHaveBeenCalledWith(coursePackId, courseEntityFirst.id);
      expect(userCourseProgressService.upsert).toHaveBeenCalled();
    });

    it("should not have nextCourse when the last course is completed", async () => {
      const { courseEntitySecond, coursePackId } = await setupDBData(db);

      const result = await courseService.completeCourse(coursePackId, courseEntitySecond.id);

      expect(result.nextCourse).toBeUndefined();
      expect(courseHistoryService.upsert).toHaveBeenCalled();
    });
  });
});

async function setupTesting() {
  const mockCourseHistoryService = {
    upsert: jest.fn(),
  };

  const mockUserCourseProgressService = {
    upsert: jest.fn(),
    findStatement: jest.fn(() => 1),
  };

  const moduleRef = await Test.createTestingModule({
    imports: testImportModules,
    providers: [
      CourseService,
      { provide: CourseHistoryService, useValue: mockCourseHistoryService },
      { provide: UserCourseProgressService, useValue: mockUserCourseProgressService },
    ],
  }).compile();

  return {
    courseService: moduleRef.get<CourseService>(CourseService),
    userCourseProgressService: moduleRef.get<UserCourseProgressService>(UserCourseProgressService),
    courseHistoryService: moduleRef.get<CourseHistoryService>(CourseHistoryService),
    db: moduleRef.get<DbType>(DB),
  };
}

async function setupDBData(db: DbType) {
  const coursePackEntity = await insertCoursePack(db);
  const courseEntityFirst = await insertCourse(db, coursePackEntity.id, {
    title: "第一课",
    order: 1,
  });
  const courseEntitySecond = await insertCourse(db, coursePackEntity.id, {
    title: "第二课",
    order: 2,
  });
  const statementEntityFirst = await insertStatement(db, courseEntityFirst.id, 1);
  const statementEntitySecond = await insertStatement(db, courseEntityFirst.id, 2);

  return {
    coursePackId: coursePackEntity.id,
    courseEntityFirst,
    courseEntitySecond,
    statementEntityFirst,
    statementEntitySecond,
  };
}

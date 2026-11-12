import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createId } from "@paralleldrive/cuid2";

import type { DbType } from "../../global/providers/db.provider";
import { insertCoursePack, insertStatement } from "../../../test/fixture/db";
import { cleanDB, testImportModules } from "../../../test/helper/utils";
import { endDB } from "../../common/db";
import { CourseHistoryService } from "../../course-history/course-history.service";
import { DB } from "../../global/providers/db.provider";
import { UserCourseProgressService } from "../../user-course-progress/user-course-progress.service";
import { CoursePackService } from "../course-pack.service";

describe("CoursePackService", () => {
  let db: DbType;
  let coursePackService: CoursePackService;
  let courseHistoryService: CourseHistoryService;

  beforeAll(async () => {
    const testHelper = await setupTesting();
    db = testHelper.db;
    coursePackService = testHelper.coursePackService;
    courseHistoryService = testHelper.courseHistoryService;
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

  describe("findOneWithCompletion", () => {
    it("should return a course pack with completion count", async () => {
      const coursePackEntity = await insertCoursePack(db);

      const result = await coursePackService.findOneWithCompletion(coursePackEntity.id);

      expect(result).toHaveProperty("completionCount");
      expect(result).not.toHaveProperty("courses");
    });

    it("should throw NotFoundException when course pack ID does not exist", async () => {
      await expect(coursePackService.findOneWithCompletion("non-existent-id")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("findLearning", () => {
    it("should return statements ordered with saved progress", async () => {
      const coursePackEntity = await insertCoursePack(db);
      await insertStatement(db, coursePackEntity.id, 2);
      await insertStatement(db, coursePackEntity.id, 1);

      const result = await coursePackService.findLearning(coursePackEntity.id);

      expect(result.statements).toHaveLength(2);
      expect(result.statements[0].order).toBe(1);
      expect(result).toHaveProperty("statementIndex");
    });

    it("should throw NotFoundException when course pack ID does not exist", async () => {
      await expect(coursePackService.findLearning(createId())).rejects.toThrow(NotFoundException);
    });
  });

  describe("findForEdit", () => {
    it("should return pack meta and statements normalized (phonetic from soundmark, ordered)", async () => {
      const coursePackEntity = await insertCoursePack(db, {
        title: "编辑我",
        description: "描述",
        cover: "c.png",
      });
      await insertStatement(db, coursePackEntity.id, 2, {
        english: "two",
        chinese: "二",
        soundmark: "/2/",
      });
      await insertStatement(db, coursePackEntity.id, 1, {
        english: "one",
        chinese: "一",
        soundmark: "/1/",
      });

      const result = await coursePackService.findForEdit(coursePackEntity.id);

      expect(result).toEqual({
        title: "编辑我",
        description: "描述",
        cover: "c.png",
        statements: [
          { english: "one", chinese: "一", phonetic: "/1/" },
          { english: "two", chinese: "二", phonetic: "/2/" },
        ],
      });
      expect(result).not.toHaveProperty("statementIndex");
    });

    it("should default empty description/cover to empty strings", async () => {
      const coursePackEntity = await insertCoursePack(db, { description: null, cover: null });

      const result = await coursePackService.findForEdit(coursePackEntity.id);

      expect(result.description).toBe("");
      expect(result.cover).toBe("");
      expect(result.statements).toEqual([]);
    });

    it("should throw NotFoundException when course pack ID does not exist", async () => {
      await expect(coursePackService.findForEdit(createId())).rejects.toThrow(NotFoundException);
    });
  });

  describe("completeCoursePack", () => {
    it("should call courseHistoryService.upsert with the pack id", async () => {
      const coursePackEntity = await insertCoursePack(db);

      await coursePackService.completeCoursePack(coursePackEntity.id);

      expect(courseHistoryService.upsert).toHaveBeenCalledWith(coursePackEntity.id);
    });

    it("should throw NotFoundException when course pack ID does not exist", async () => {
      await expect(coursePackService.completeCoursePack(createId())).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});

async function setupTesting() {
  const MockUserCourseProgressService = {
    findStatement: jest.fn(() => 0),
  };

  const MockCourseHistoryService = {
    findCompletionCount: jest.fn(() => 1),
    upsert: jest.fn(),
  };

  const moduleRef = await Test.createTestingModule({
    imports: testImportModules,
    providers: [
      CoursePackService,
      { provide: UserCourseProgressService, useValue: MockUserCourseProgressService },
      { provide: CourseHistoryService, useValue: MockCourseHistoryService },
    ],
  }).compile();

  return {
    moduleRef,
    courseHistoryService: moduleRef.get<CourseHistoryService>(CourseHistoryService),
    coursePackService: moduleRef.get<CoursePackService>(CoursePackService),
    db: moduleRef.get<DbType>(DB),
  };
}

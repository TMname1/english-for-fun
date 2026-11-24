import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";

import { coursePack } from "@earthworm/schema";
import type { DbType } from "../../global/providers/db.provider";
import { insertCoursePack, insertMasteredElement, insertStatement } from "../../../test/fixture/db";
import { cleanDB, testImportModules } from "../../../test/helper/utils";
import { endDB } from "../../common/db";
import { CourseHistoryService } from "../../course-history/course-history.service";
import { DB } from "../../global/providers/db.provider";
import { StorageService } from "../../storage/storage.service";
import { UserCourseProgressService } from "../../user-course-progress/user-course-progress.service";
import { CoursePackService } from "../course-pack.service";

describe("CoursePackService", () => {
  let db: DbType;
  let coursePackService: CoursePackService;
  let courseHistoryService: CourseHistoryService;
  let storage: {
    presignVideoUrl: jest.Mock;
    deleteObject: jest.Mock;
    deleteByPrefix: jest.Mock;
  };

  beforeAll(async () => {
    const testHelper = await setupTesting();
    db = testHelper.db;
    coursePackService = testHelper.coursePackService;
    courseHistoryService = testHelper.courseHistoryService;
    storage = testHelper.storage;
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

    it("should presign object-key videos and mark them internal", async () => {
      const coursePackEntity = await insertCoursePack(db, { video: "course-video/x.mp4" });

      const result = await coursePackService.findOneWithCompletion(coursePackEntity.id);

      expect(result.video).toBe("https://oss.test/course-video/x.mp4?sig");
      expect(result.videoIsExternal).toBe(false);
      expect(result.mediaKind).toBe("video");
    });

    it("should pass external video URLs through untouched", async () => {
      const coursePackEntity = await insertCoursePack(db, {
        video: "https://example.com/v.mp4",
      });

      const result = await coursePackService.findOneWithCompletion(coursePackEntity.id);

      expect(result.video).toBe("https://example.com/v.mp4");
      expect(result.videoIsExternal).toBe(true);
      expect(result.mediaKind).toBe("video");
    });

    it("should mark audio media so the player renders a bar instead of a picture", async () => {
      const coursePackEntity = await insertCoursePack(db, { video: "course-video/song.mp3" });

      const result = await coursePackService.findOneWithCompletion(coursePackEntity.id);

      expect(result.mediaKind).toBe("audio");
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

    it("should presign the video for playback", async () => {
      const coursePackEntity = await insertCoursePack(db, { video: "course-video/x.mp4" });

      const result = await coursePackService.findLearning(coursePackEntity.id);

      expect(result.video).toBe("https://oss.test/course-video/x.mp4?sig");
      expect(result.videoIsExternal).toBe(false);
      expect(result.mediaKind).toBe("video");
    });

    it("should mark audio media as audio", async () => {
      const coursePackEntity = await insertCoursePack(db, { video: "course-video/song.m4a" });

      const result = await coursePackService.findLearning(coursePackEntity.id);

      expect(result.mediaKind).toBe("audio");
    });

    it("should default to video when the pack has no media", async () => {
      const coursePackEntity = await insertCoursePack(db);

      const result = await coursePackService.findLearning(coursePackEntity.id);

      expect(result.mediaKind).toBe("video");
    });
  });

  describe("findStatementsPage", () => {
    async function seedPack(count: number) {
      const pack = await insertCoursePack(db);
      for (let i = 1; i <= count; i++) {
        await insertStatement(db, pack.id, i, { english: `sentence-${i}` });
      }
      return pack;
    }

    it("should return only one page of statements with absolute indexes", async () => {
      const pack = await seedPack(5);

      const first = await coursePackService.findStatementsPage(pack.id, {
        page: "1",
        pageSize: "2",
      });

      expect(first.items).toHaveLength(2);
      expect(first.items.map((item) => item.index)).toEqual([0, 1]);
      expect(first.items[0].english).toBe("sentence-1");
      expect(first.total).toBe(5);
      expect(first.totalPages).toBe(3);

      const last = await coursePackService.findStatementsPage(pack.id, {
        page: "3",
        pageSize: "2",
      });

      expect(last.items).toHaveLength(1);
      expect(last.items[0].index).toBe(4);
    });

    it("should default to page 1 and cap pageSize at 100", async () => {
      const pack = await seedPack(3);

      const result = await coursePackService.findStatementsPage(pack.id, { pageSize: "1000" });

      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(100);
      expect(result.items).toHaveLength(3);
    });

    it("should return an empty page when page is beyond the end", async () => {
      const pack = await seedPack(2);

      const result = await coursePackService.findStatementsPage(pack.id, { page: "9" });

      expect(result.items).toEqual([]);
      expect(result.total).toBe(2);
      expect(result.totalPages).toBe(1);
    });

    it("should filter mastered statements and keep absolute indexes", async () => {
      const pack = await seedPack(4);
      await insertMasteredElement(db, "SENTENCE-2");

      const mastered = await coursePackService.findStatementsPage(pack.id, { filter: "mastered" });

      expect(mastered.total).toBe(1);
      expect(mastered.items[0].index).toBe(1);
      expect(mastered.items[0].isMastered).toBe(true);

      const notMastered = await coursePackService.findStatementsPage(pack.id, {
        filter: "notMastered",
      });

      expect(notMastered.total).toBe(3);
      // 被筛掉的句子不压缩下标：第 2 句（index 1）缺失后仍是 0,2,3
      expect(notMastered.items.map((item) => item.index)).toEqual([0, 2, 3]);
      expect(notMastered.items.every((item) => item.isMastered === false)).toBe(true);
    });

    it("should reject unknown filter values", async () => {
      const pack = await seedPack(1);

      await expect(
        coursePackService.findStatementsPage(pack.id, { filter: "whatever" }),
      ).rejects.toThrow("不支持的 filter");
    });

    it("should throw NotFoundException when course pack ID does not exist", async () => {
      await expect(coursePackService.findStatementsPage(createId())).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("findForEdit", () => {
    it("should return pack meta, video and statements normalized (phonetic from soundmark, ordered)", async () => {
      const coursePackEntity = await insertCoursePack(db, {
        title: "编辑我",
        description: "描述",
        cover: "c.png",
        video: "course-video/e2e.mp4",
      });
      await insertStatement(db, coursePackEntity.id, 2, {
        english: "two",
        chinese: "二",
        soundmark: "/2/",
        startTime: 3,
        endTime: 4,
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
        video: "course-video/e2e.mp4",
        mediaKind: "video",
        statements: [
          { english: "one", chinese: "一", phonetic: "/1/" },
          { english: "two", chinese: "二", phonetic: "/2/", startTime: 3, endTime: 4 },
        ],
      });
      expect(result).not.toHaveProperty("statementIndex");
    });

    it("should default empty description/cover/video to empty strings", async () => {
      const coursePackEntity = await insertCoursePack(db, {
        description: null,
        cover: null,
        video: null,
      });

      const result = await coursePackService.findForEdit(coursePackEntity.id);

      expect(result.description).toBe("");
      expect(result.cover).toBe("");
      expect(result.video).toBe("");
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

  describe("delete", () => {
    it("should delete the pack and remove unreferenced video object plus forge artifacts", async () => {
      const pack = await insertCoursePack(db, { video: "course-video/abc.mp4" });

      const result = await coursePackService.delete(pack.id);

      expect(result).toEqual({ deleted: true, coursePackId: pack.id });
      expect(
        await db.query.coursePack.findFirst({ where: eq(coursePack.id, pack.id) }),
      ).toBeUndefined();
      expect(storage.deleteObject).toHaveBeenCalledWith("course-video/abc.mp4");
      expect(storage.deleteByPrefix).toHaveBeenCalledWith("forge/abc/");
    });

    it("should keep the video object while another pack references the same key", async () => {
      const first = await insertCoursePack(db, { video: "course-video/shared.mp4" });
      const second = await insertCoursePack(db, { video: "course-video/shared.mp4", order: 2 });

      await coursePackService.delete(first.id);
      expect(storage.deleteObject).not.toHaveBeenCalled();
      expect(storage.deleteByPrefix).not.toHaveBeenCalled();

      await coursePackService.delete(second.id);
      expect(storage.deleteObject).toHaveBeenCalledTimes(1);
      expect(storage.deleteObject).toHaveBeenCalledWith("course-video/shared.mp4");
      expect(storage.deleteByPrefix).toHaveBeenCalledWith("forge/shared/");
    });

    it("should not touch storage for external video URLs", async () => {
      const pack = await insertCoursePack(db, { video: "https://example.com/v.mp4" });

      await coursePackService.delete(pack.id);

      expect(storage.deleteObject).not.toHaveBeenCalled();
      expect(storage.deleteByPrefix).not.toHaveBeenCalled();
    });

    it("should not touch storage when the pack has no video", async () => {
      const pack = await insertCoursePack(db);

      await coursePackService.delete(pack.id);

      expect(storage.deleteObject).not.toHaveBeenCalled();
      expect(storage.deleteByPrefix).not.toHaveBeenCalled();
    });

    it("should still report deletion when storage cleanup fails", async () => {
      const pack = await insertCoursePack(db, { video: "course-video/fail.mp4" });
      storage.deleteObject.mockRejectedValueOnce(new Error("S3 down"));

      const result = await coursePackService.delete(pack.id);

      expect(result).toEqual({ deleted: true, coursePackId: pack.id });
      expect(
        await db.query.coursePack.findFirst({ where: eq(coursePack.id, pack.id) }),
      ).toBeUndefined();
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

  const MockStorageService = {
    presignVideoUrl: jest.fn(async (value: string | null | undefined) => {
      const v = value?.trim();
      if (!v) return "";
      return /^https?:\/\//i.test(v) ? v : `https://oss.test/${v}?sig`;
    }),
    deleteObject: jest.fn(async (_key: string) => {}),
    deleteByPrefix: jest.fn(async (_prefix: string) => {}),
  };

  const moduleRef = await Test.createTestingModule({
    imports: testImportModules,
    providers: [
      CoursePackService,
      { provide: UserCourseProgressService, useValue: MockUserCourseProgressService },
      { provide: CourseHistoryService, useValue: MockCourseHistoryService },
      { provide: StorageService, useValue: MockStorageService },
    ],
  }).compile();

  return {
    moduleRef,
    courseHistoryService: moduleRef.get<CourseHistoryService>(CourseHistoryService),
    coursePackService: moduleRef.get<CoursePackService>(CoursePackService),
    storage: MockStorageService,
    db: moduleRef.get<DbType>(DB),
  };
}

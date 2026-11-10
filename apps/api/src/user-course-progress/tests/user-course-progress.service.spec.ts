import { Test } from "@nestjs/testing";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";

import { userCourseProgress } from "@earthworm/schema";
import { insertCoursePack } from "../../../test/fixture/db";
import { cleanDB, testImportModules } from "../../../test/helper/utils";
import { endDB } from "../../common/db";
import { DB, DbType } from "../../global/providers/db.provider";
import { UserCourseProgressService } from "../user-course-progress.service";

describe("user-progress service", () => {
  let userCourseProgressService: UserCourseProgressService;
  let db: DbType;

  beforeAll(async () => {
    const testHelper = await setupTesting();
    await cleanDB(testHelper.db);

    db = testHelper.db;
    userCourseProgressService = testHelper.userCourseProgressService;
  });

  afterAll(async () => {
    await cleanDB(db);
    await endDB();
  });

  beforeEach(async () => {
    await cleanDB(db);
  });

  it("should update an existing progress entry", async () => {
    const coursePackId = createId();
    const courseId = createId();
    await userCourseProgressService.upsert(coursePackId, courseId, 1);
    await userCourseProgressService.upsert(coursePackId, courseId, 2);

    const result = await userCourseProgressService.findStatement(coursePackId, courseId);

    expect(result).toBe(2);
  });

  it("should return 0 when there is no progress", async () => {
    const statementIndex = await userCourseProgressService.findStatement(createId(), createId());

    expect(statementIndex).toBe(0);
  });

  describe("getRecentCoursePacks", () => {
    it("should return recent course packs up to the limit", async () => {
      const first = await insertCoursePack(db, { order: 1, title: "零基础" });
      const second = await insertCoursePack(db, { order: 2, title: "300个基础句子" });

      await userCourseProgressService.upsert(first.id, createId(), 1);
      await userCourseProgressService.upsert(second.id, createId(), 1);

      const recentCoursePacks = await userCourseProgressService.getRecentCoursePacks(1);

      expect(recentCoursePacks.length).toBe(1);
      expect(recentCoursePacks[0]).toEqual(
        expect.objectContaining({
          coursePackId: second.id,
          title: second.title,
        }),
      );
    });

    it("should order results by most recently updated progress", async () => {
      const first = await insertCoursePack(db, { order: 1, title: "零基础" });
      const second = await insertCoursePack(db, { order: 2, title: "300个基础句子" });
      const third = await insertCoursePack(db, { order: 3, title: "一般经典句子" });

      await userCourseProgressService.upsert(first.id, createId(), 1);
      await userCourseProgressService.upsert(second.id, createId(), 1);
      await userCourseProgressService.upsert(third.id, createId(), 1);

      // 新插入的进度记录 updated_at 为空，显式写入时间戳保证排序可预期
      const now = Date.now();
      await setUpdatedAt(db, first.id, new Date(now));
      await setUpdatedAt(db, second.id, new Date(now + 1000));
      await setUpdatedAt(db, third.id, new Date(now + 2000));

      const recentCoursePacks = await userCourseProgressService.getRecentCoursePacks(3);

      expect(recentCoursePacks.map((recentCoursePack) => recentCoursePack.coursePackId)).toEqual([
        third.id,
        second.id,
        first.id,
      ]);
    });

    it("should filter out progress rows whose course pack no longer exists", async () => {
      const existingPack = await insertCoursePack(db, { order: 1, title: "零基础" });

      await userCourseProgressService.upsert(existingPack.id, createId(), 1);
      // 模拟课程包被删除后遗留的孤儿进度记录
      await userCourseProgressService.upsert(createId(), createId(), 2);

      const recentCoursePacks = await userCourseProgressService.getRecentCoursePacks(3);

      expect(recentCoursePacks.length).toBe(1);
      expect(recentCoursePacks[0].coursePackId).toBe(existingPack.id);
      expect(recentCoursePacks[0].title).toBe(existingPack.title);
      expect(recentCoursePacks[0]).not.toHaveProperty("cover");
    });
  });
});

async function setupTesting() {
  const moduleRef = await Test.createTestingModule({
    imports: testImportModules,
    providers: [UserCourseProgressService],
  }).compile();

  return {
    db: moduleRef.get<DbType>(DB),
    userCourseProgressService: moduleRef.get<UserCourseProgressService>(UserCourseProgressService),
  };
}

async function setUpdatedAt(db: DbType, coursePackId: string, updatedAt: Date) {
  await db
    .update(userCourseProgress)
    .set({ updatedAt })
    .where(eq(userCourseProgress.coursePackId, coursePackId));
}

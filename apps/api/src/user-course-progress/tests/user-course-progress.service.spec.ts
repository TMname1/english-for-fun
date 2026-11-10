import { Test } from "@nestjs/testing";
import { createId } from "@paralleldrive/cuid2";

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

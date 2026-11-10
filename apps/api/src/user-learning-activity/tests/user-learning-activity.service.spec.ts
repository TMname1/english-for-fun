import { Test } from "@nestjs/testing";

import { cleanDB, testImportModules } from "../../../test/helper/utils";
import { endDB } from "../../common/db";
import { DB, DbType } from "../../global/providers/db.provider";
import { UserLearningActivityService } from "../user-learning-activity.service";

describe("UserLearningActivityService", () => {
  let db: DbType;
  let service: UserLearningActivityService;

  const activityType = "daily_total";

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: testImportModules,
      providers: [UserLearningActivityService],
    }).compile();

    db = moduleRef.get<DbType>(DB);
    service = moduleRef.get<UserLearningActivityService>(UserLearningActivityService);
  });

  afterAll(async () => {
    await cleanDB(db);
    await endDB();
  });

  beforeEach(async () => {
    await cleanDB(db);
  });

  describe("upsertActivity", () => {
    it("should create a new activity record", async () => {
      const date = new Date("2024-01-01");

      const result = await service.upsertActivity(date, activityType, 100);

      expect(result).toBe(true);
    });

    it("should accumulate duration for the same date and activity type", async () => {
      const date = new Date("2024-01-01");

      await service.upsertActivity(date, activityType, 100);
      await service.upsertActivity(date, activityType, 50);

      const result = await service.getDailyTotalTime(activityType, date, date);

      expect(result).toEqual([{ date: "2024-01-01", duration: 150 }]);
    });

    it("should throw when duration is negative", async () => {
      await expect(
        service.upsertActivity(new Date("2024-01-01"), activityType, -1),
      ).rejects.toThrow();
    });
  });

  describe("getDailyTotalTime", () => {
    it("should group durations by date", async () => {
      await service.upsertActivity(new Date("2024-01-01"), activityType, 100);
      await service.upsertActivity(new Date("2024-01-02"), activityType, 200);

      const result = await service.getDailyTotalTime(activityType);

      expect(result).toEqual([
        { date: "2024-01-01", duration: 100 },
        { date: "2024-01-02", duration: 200 },
      ]);
    });

    it("should filter by date range", async () => {
      await service.upsertActivity(new Date("2024-01-01"), activityType, 100);
      await service.upsertActivity(new Date("2024-01-02"), activityType, 200);

      const result = await service.getDailyTotalTime(
        activityType,
        new Date("2024-01-02"),
        new Date("2024-01-02"),
      );

      expect(result).toEqual([{ date: "2024-01-02", duration: 200 }]);
    });
  });

  describe("getTotalLearningTime", () => {
    it("should return the sum of all durations", async () => {
      await service.upsertActivity(new Date("2024-01-01"), activityType, 100);
      await service.upsertActivity(new Date("2024-01-02"), activityType, 200);

      const result = await service.getTotalLearningTime(activityType);

      expect(result).toBe(300);
    });

    it("should return 0 when no records exist", async () => {
      const result = await service.getTotalLearningTime(activityType);

      expect(result).toBe(0);
    });
  });
});

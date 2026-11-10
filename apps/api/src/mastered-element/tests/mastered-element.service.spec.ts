import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";

import { cleanDB, testImportModules } from "../../../test/helper/utils";
import { endDB } from "../../common/db";
import { DB, DbType } from "../../global/providers/db.provider";
import { MasteredElementService } from "../mastered-element.service";

describe("MasteredElementService", () => {
  let db: DbType;
  let masteredElementService: MasteredElementService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: testImportModules,
      providers: [MasteredElementService],
    }).compile();

    db = module.get<DbType>(DB);
    masteredElementService = module.get<MasteredElementService>(MasteredElementService);
  });

  afterAll(async () => {
    await cleanDB(db);
    await endDB();
  });

  beforeEach(async () => {
    await cleanDB(db);
  });

  describe("addMasteredElement", () => {
    it("should successfully add a new mastered element", async () => {
      const content = { english: "test" };
      const result = await masteredElementService.addMasteredElement(content);
      expect(result).toBeDefined();
      expect(result.content).toEqual(content);
    });

    it("should throw BadRequestException when adding an existing element", async () => {
      const content = { english: "test" };
      await masteredElementService.addMasteredElement(content);
      await expect(masteredElementService.addMasteredElement(content)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw BadRequestException when adding element without english property", async () => {
      const content = { someOtherProperty: "test" };
      await expect(masteredElementService.addMasteredElement(content as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should correctly handle additional properties in content", async () => {
      const content = { english: "test", chinese: "测试" };
      const result = await masteredElementService.addMasteredElement(content);
      expect(result.content).toEqual(content);
    });
  });

  describe("getMasteredElements", () => {
    it("should return all mastered elements", async () => {
      const contents = [{ english: "test1" }, { english: "test2" }, { english: "test3" }];
      for (const content of contents) {
        await masteredElementService.addMasteredElement(content);
      }

      const result = await masteredElementService.getMasteredElements();

      expect(result).toHaveLength(3);
    });

    it("should return an empty array when there are no mastered elements", async () => {
      const result = await masteredElementService.getMasteredElements();
      expect(result).toEqual([]);
    });
  });

  describe("removeMasteredElement", () => {
    it("should successfully remove an existing mastered element", async () => {
      const content = { english: "test" };
      const addedElement = await masteredElementService.addMasteredElement(content);
      await masteredElementService.removeMasteredElement(addedElement.id);
      const elements = await masteredElementService.getMasteredElements();
      expect(elements).toHaveLength(0);
    });

    it("should throw NotFoundException when removing a non-existent element", async () => {
      await expect(masteredElementService.removeMasteredElement("nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});

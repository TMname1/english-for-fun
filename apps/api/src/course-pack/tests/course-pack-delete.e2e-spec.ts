import { INestApplication } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { eq } from "drizzle-orm";
import * as request from "supertest";

import { coursePack } from "@earthworm/schema";
import { insertCoursePack } from "../../../test/fixture/db";
import { cleanDB, createAuthedAgent } from "../../../test/helper/utils";
import { AppModule } from "../../app/app.module";
import { appGlobalMiddleware } from "../../app/useGlobal";
import { endDB } from "../../common/db";
import { DB, DbType } from "../../global/providers/db.provider";
import { StorageService } from "../../storage/storage.service";

describe("course-pack delete cascade (storage mocked)", () => {
  let app: INestApplication;
  let db: DbType;
  let agent: ReturnType<typeof request.agent>;
  let storage: { deleteObject: jest.Mock; deleteByPrefix: jest.Mock };

  beforeEach(async () => {
    storage = {
      deleteObject: jest.fn(async (_key: string) => {}),
      deleteByPrefix: jest.fn(async (_prefix: string) => {}),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(StorageService)
      .useValue(storage)
      .compile();

    app = moduleFixture.createNestApplication();
    appGlobalMiddleware(app);
    db = moduleFixture.get<DbType>(DB);

    await app.init();
    agent = await createAuthedAgent(app);

    await cleanDB(db);
  });

  afterEach(async () => {
    await cleanDB(db);
    await endDB();
    await app.close();
  });

  it("delete removes the video object and forge artifacts when the last reference is gone", async () => {
    const { id } = await insertCoursePack(db, { video: "course-video/job-1.mp4" });

    await agent.delete(`/course-pack/${id}`).expect(200);

    expect(await db.query.coursePack.findFirst({ where: eq(coursePack.id, id) })).toBeUndefined();
    expect(storage.deleteObject).toHaveBeenCalledWith("course-video/job-1.mp4");
    expect(storage.deleteByPrefix).toHaveBeenCalledWith("forge/job-1/");
  });

  it("delete keeps shared objects until the last referencing pack is deleted", async () => {
    const first = await insertCoursePack(db, { video: "course-video/shared.mp4" });
    const second = await insertCoursePack(db, {
      video: "course-video/shared.mp4",
      order: 2,
    });

    await agent.delete(`/course-pack/${first.id}`).expect(200);
    expect(storage.deleteObject).not.toHaveBeenCalled();

    await agent.delete(`/course-pack/${second.id}`).expect(200);
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
    expect(storage.deleteObject).toHaveBeenCalledWith("course-video/shared.mp4");
    expect(storage.deleteByPrefix).toHaveBeenCalledWith("forge/shared/");
  });

  it("delete leaves external video URLs alone", async () => {
    const { id } = await insertCoursePack(db, { video: "https://example.com/v.mp4" });

    await agent.delete(`/course-pack/${id}`).expect(200);

    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(storage.deleteByPrefix).not.toHaveBeenCalled();
  });
});

import { INestApplication } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import * as request from "supertest";

import { userCourseProgress } from "@earthworm/schema";
import { insertCoursePack, insertUserCourseProgress } from "../../../test/fixture/db";
import { cleanDB, createAuthedAgent } from "../../../test/helper/utils";
import { AppModule } from "../../app/app.module";
import { appGlobalMiddleware } from "../../app/useGlobal";
import { endDB } from "../../common/db";
import { DB, DbType } from "../../global/providers/db.provider";

describe("user-progress e2e", () => {
  let app: INestApplication;
  let db: DbType;
  let agent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    appGlobalMiddleware(app);
    db = moduleFixture.get<DbType>(DB);
    await app.init();
    agent = await createAuthedAgent(app);
  });

  afterEach(async () => {
    await cleanDB(db);
  });

  afterAll(async () => {
    await endDB();
    await app.close();
  });

  it("get: /user-course-progress/recent-course-packs", async () => {
    const firstPack = await insertCoursePack(db, {
      order: 1,
      title: "零基础",
      description: "从零开始",
    });
    const secondPack = await insertCoursePack(db, {
      order: 2,
      title: "300个基础句子",
      description: "常用句子",
    });
    await insertUserCourseProgress(db, firstPack.id, 0);
    await insertUserCourseProgress(db, secondPack.id, 10);
    // 课程包被删除后遗留的孤儿进度，不应出现在返回结果里
    await insertUserCourseProgress(db, createId(), 3);

    await agent
      .get("/user-course-progress/recent-course-packs")
      .expect(200)
      .expect(({ body }) => {
        expect(body.length).toBe(2);
        expect(body.map((item: { coursePackId: string }) => item.coursePackId)).toEqual(
          expect.arrayContaining([firstPack.id, secondPack.id]),
        );
        expect(body[0]).toEqual(
          expect.objectContaining({
            title: expect.any(String),
            description: expect.any(String),
          }),
        );
        expect(body[0]).not.toHaveProperty("cover");
        expect(body[0]).not.toHaveProperty("courseId");
      });
  });

  it("get: /user-course-progress/recent-course-packs should never return more than 3 items", async () => {
    for (let order = 1; order <= 4; order++) {
      const pack = await insertCoursePack(db, { order, title: `课程包${order}` });
      await insertUserCourseProgress(db, pack.id, order);
    }

    await agent
      .get("/user-course-progress/recent-course-packs?limit=100")
      .expect(200)
      .expect(({ body }) => {
        expect(body.length).toBe(3);
      });

    await agent
      .get("/user-course-progress/recent-course-packs?limit=abc")
      .expect(200)
      .expect(({ body }) => {
        expect(body.length).toBe(3);
      });
  });

  it("put: /user-course-progress", async () => {
    const { id: coursePackId } = await insertCoursePack(db);

    await agent
      .put("/user-course-progress")
      .send({
        coursePackId,
        statementIndex: 10,
      })
      .expect(200)
      .expect(async () => {
        const result = await db.query.userCourseProgress.findFirst({
          where: eq(userCourseProgress.coursePackId, coursePackId),
        });

        expect(result?.statementIndex).toBe(10);
      });
  });
});

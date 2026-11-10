import { INestApplication } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import * as request from "supertest";

import { course, courseHistory, coursePack, statement } from "@earthworm/schema";
import {
  insertCourse,
  insertCoursePack,
  insertStatement,
  insertUserCourseProgress,
} from "../../../test/fixture/db";
import { cleanDB } from "../../../test/helper/utils";
import { AppModule } from "../../app/app.module";
import { appGlobalMiddleware } from "../../app/useGlobal";
import { endDB } from "../../common/db";
import { DB, DbType } from "../../global/providers/db.provider";

describe("course-pack e2e", () => {
  let app: INestApplication;
  let db: DbType;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    appGlobalMiddleware(app);
    db = moduleFixture.get<DbType>(DB);

    await app.init();

    await cleanDB(db);
  });

  afterEach(async () => {
    await cleanDB(db);
    await endDB();
    await app.close();
  });

  it("get: /course-pack", async () => {
    await insertCoursePack(db);
    return request(app.getHttpServer())
      .get("/course-pack")
      .expect(200)
      .expect(({ body }) => {
        expect(body.length).toBe(1);
      });
  });

  it("post: /course-pack", async () => {
    return request(app.getHttpServer())
      .post("/course-pack")
      .send({
        title: "新对话课程",
        description: "用 POST 创建",
        cover: "",
        courses: [
          {
            title: "第一课",
            description: "",
            statements: [
              { english: "How are you?", chinese: "你好吗？", phonetic: "" },
              { english: "I am fine.", chinese: "我很好。" },
            ],
          },
        ],
      })
      .expect(201)
      .expect(async ({ body }) => {
        expect(body.coursePackId).toBeTruthy();
        expect(body.courseIds).toHaveLength(1);

        const packs = await db.query.coursePack.findMany();
        expect(packs).toHaveLength(1);
        expect(packs[0]!.title).toBe("新对话课程");

        const statements = await db.query.statement.findMany();
        expect(statements).toHaveLength(2);
      });
  });

  it("post: /course-pack with invalid payload returns 400", async () => {
    return request(app.getHttpServer())
      .post("/course-pack")
      .send({ title: "", courses: [] })
      .expect(400);
  });

  it("delete: /course-pack/:coursePackId removes pack with its courses, statements and progress", async () => {
    const { id: coursePackId } = await insertCoursePack(db);
    const { id: courseId } = await insertCourse(db, coursePackId);
    await insertStatement(db, courseId, 1);
    await insertStatement(db, courseId, 2);
    await insertUserCourseProgress(db, coursePackId, courseId, 0);
    await db.insert(courseHistory).values({ coursePackId, courseId, completionCount: 1 });

    return request(app.getHttpServer())
      .delete(`/course-pack/${coursePackId}`)
      .expect(200)
      .expect(async ({ body }) => {
        expect(body).toEqual({ deleted: true, coursePackId });

        expect(
          await db.query.coursePack.findFirst({ where: eq(coursePack.id, coursePackId) }),
        ).toBeUndefined();
        expect(
          await db.query.course.findMany({ where: eq(course.coursePackId, coursePackId) }),
        ).toHaveLength(0);
        expect(
          await db.query.statement.findMany({ where: eq(statement.courseId, courseId) }),
        ).toHaveLength(0);
        expect(
          await db.query.courseHistory.findMany({
            where: eq(courseHistory.coursePackId, coursePackId),
          }),
        ).toHaveLength(0);
      });
  });

  it("delete: /course-pack/:coursePackId with unknown id returns 404", async () => {
    return request(app.getHttpServer()).delete(`/course-pack/${createId()}`).expect(404);
  });

  it("get: /course-pack/:coursePackId", async () => {
    const { id: coursePackId } = await insertCoursePack(db);
    await insertCourse(db, coursePackId);
    await insertCourse(db, coursePackId);

    return request(app.getHttpServer())
      .get(`/course-pack/${coursePackId}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toHaveProperty("courses");
        expect(body).toHaveProperty("order");
        expect(body).toHaveProperty("title");
      });
  });

  it("get: /course-pack/:coursePackId/courses/:courseId", async () => {
    const { id: coursePackId } = await insertCoursePack(db);
    const { id: courseId } = await insertCourse(db, coursePackId);
    await insertStatement(db, courseId, 1);
    await insertStatement(db, courseId, 2);

    return request(app.getHttpServer())
      .get(`/course-pack/${coursePackId}/courses/${courseId}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toHaveProperty("coursePackId");
        expect(body).toHaveProperty("order");
        expect(body).toHaveProperty("statements");
      });
  });

  it("get: /course-pack/:coursePackId/courses/:courseId/next", async () => {
    const { id: coursePackId } = await insertCoursePack(db);

    const { id: courseId } = await insertCourse(db, coursePackId, {
      order: 1,
      title: "第一课",
    });
    const { id: courseIdNext } = await insertCourse(db, coursePackId, {
      order: 2,
      title: "第二课",
    });

    return request(app.getHttpServer())
      .get(`/course-pack/${coursePackId}/courses/${courseId}/next`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.id).toBe(courseIdNext);
      });
  });

  it("post: /course-pack/:coursePackId/courses/:courseId/complete", async () => {
    const { id: coursePackId } = await insertCoursePack(db);

    const { id: courseId } = await insertCourse(db, coursePackId, {
      order: 1,
      title: "第一课",
    });
    const { id: courseIdNext } = await insertCourse(db, coursePackId, {
      order: 2,
      title: "第二课",
    });

    return request(app.getHttpServer())
      .post(`/course-pack/${coursePackId}/courses/${courseId}/complete`)
      .expect(201)
      .expect(({ body }) => {
        expect(body.nextCourse.id).toBe(courseIdNext);
      });
  });
});

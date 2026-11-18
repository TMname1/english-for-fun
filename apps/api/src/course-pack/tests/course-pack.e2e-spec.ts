import { INestApplication } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import * as request from "supertest";

import { courseHistory, coursePack, statement } from "@earthworm/schema";
import {
  insertCoursePack,
  insertStatement,
  insertUserCourseProgress,
} from "../../../test/fixture/db";
import { cleanDB, createAuthedAgent } from "../../../test/helper/utils";
import { AppModule } from "../../app/app.module";
import { appGlobalMiddleware } from "../../app/useGlobal";
import { endDB } from "../../common/db";
import { DB, DbType } from "../../global/providers/db.provider";

describe("course-pack e2e", () => {
  let app: INestApplication;
  let db: DbType;
  let agent: ReturnType<typeof request.agent>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

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

  it("get: /course-pack", async () => {
    await insertCoursePack(db);
    return agent
      .get("/course-pack")
      .expect(200)
      .expect(({ body }) => {
        expect(body.length).toBe(1);
      });
  });

  it("post: /course-pack", async () => {
    return agent
      .post("/course-pack")
      .send({
        title: "新对话课程",
        description: "用 POST 创建",
        cover: "",
        courses: {
          title: "第一课",
          description: "",
          statements: [
            {
              english: "How are you?",
              chinese: "你好吗？",
              phonetic: "",
            },
            { english: "I am fine.", chinese: "我很好。" },
          ],
        },
      })
      .expect(201)
      .expect(async ({ body }) => {
        expect(body.coursePackId).toBeTruthy();

        const packs = await db.query.coursePack.findMany();
        expect(packs).toHaveLength(1);
        expect(packs[0]!.title).toBe("新对话课程");

        const statements = await db.query.statement.findMany();
        expect(statements).toHaveLength(2);
        expect(new Set(statements.map((s) => s.coursePackId)).size).toBe(1);
        expect(statements[0]!.coursePackId).toBe(body.coursePackId);
      });
  });

  it("post: /course-pack with invalid payload returns 400", async () => {
    return agent
      .post("/course-pack")
      .send({ title: "", courses: { statements: [] } })
      .expect(400);
  });

  it("post: /course-pack persists video key and statement timings; learning presigns the video", async () => {
    const words = [
      { word: "How", start: 1, end: 1.3 },
      { word: "are", start: 1.3, end: 1.6 },
      { word: "you", start: 1.6, end: 2 },
    ];
    const { body } = await agent
      .post("/course-pack")
      .send({
        title: "视频课程",
        video: "course-video/20261113-120000.mp4",
        courses: {
          statements: [
            { english: "How are you", chinese: "你好吗", startTime: 1, endTime: 2, words },
            { english: "I am fine", chinese: "我很好" },
          ],
        },
      })
      .expect(201);

    const pack = await db.query.coursePack.findFirst({
      where: eq(coursePack.id, body.coursePackId),
    });
    expect(pack?.video).toBe("course-video/20261113-120000.mp4");

    const statements = await db.query.statement.findMany({
      where: eq(statement.coursePackId, body.coursePackId),
      orderBy: (table, { asc }) => [asc(table.order)],
    });
    expect(statements[0]!.startTime).toBe(1);
    expect(statements[0]!.endTime).toBe(2);
    expect(statements[0]!.words).toEqual(words);
    expect(statements[1]!.startTime).toBeNull();
    expect(statements[1]!.words).toBeNull();

    // learning 接口：对象键转预签名 URL（签名是本地计算，e2e 不需要真实 OSS），时间戳原样带出
    await agent
      .get(`/course-pack/${body.coursePackId}/learning`)
      .expect(200)
      .expect(({ body: learning }) => {
        expect(learning.video).toMatch(/^https?:\/\//);
        expect(learning.video).toContain("course-video/20261113-120000.mp4");
        expect(learning.video).toContain("X-Amz-Signature");
        expect(learning.videoIsExternal).toBe(false);
        expect(learning.statements[0].startTime).toBe(1);
        expect(learning.statements[0].words).toEqual(words);
      });
  });

  it("learning passes external video URLs through with videoIsExternal=true", async () => {
    const { id } = await insertCoursePack(db, { video: "https://example.com/v.mp4" });

    await agent
      .get(`/course-pack/${id}/learning`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.video).toBe("https://example.com/v.mp4");
        expect(body.videoIsExternal).toBe(true);
      });
  });

  it("patch: /course-pack/:coursePackId keeps timings only for unchanged english", async () => {
    const words = [{ word: "old", start: 0, end: 0.5 }];
    const { id: coursePackId } = await insertCoursePack(db, { video: "course-video/v.mp4" });
    await insertStatement(db, coursePackId, 1, {
      english: "keep",
      startTime: 1,
      endTime: 2,
      words,
    });
    await insertStatement(db, coursePackId, 2, {
      english: "change",
      startTime: 3,
      endTime: 4,
      words,
    });

    await agent
      .patch(`/course-pack/${coursePackId}`)
      .send({
        title: "编辑后",
        courses: {
          statements: [
            { english: "keep", chinese: "保留", phonetic: "" },
            { english: "changed", chinese: "改了", phonetic: "" },
          ],
        },
      })
      .expect(200);

    const statements = await db.query.statement.findMany({
      where: eq(statement.coursePackId, coursePackId),
      orderBy: (table, { asc }) => [asc(table.order)],
    });
    expect(statements[0]!.startTime).toBe(1);
    expect(statements[0]!.endTime).toBe(2);
    expect(statements[0]!.words).toEqual(words);
    expect(statements[1]!.startTime).toBeNull();
    expect(statements[1]!.endTime).toBeNull();
    expect(statements[1]!.words).toBeNull();

    // 编辑表单不传 video 时保留原值
    const pack = await db.query.coursePack.findFirst({
      where: eq(coursePack.id, coursePackId),
    });
    expect(pack?.video).toBe("course-video/v.mp4");
  });

  it("static media routes are removed: /course-audio and /course-video return 404 when authed", async () => {
    await agent.get("/course-audio/whatever.mp3").expect(404);
    await agent.get("/course-video/whatever.mp4").expect(404);
  });

  it("delete: /course-pack/:coursePackId removes pack with its statements and progress", async () => {
    const { id: coursePackId } = await insertCoursePack(db);
    await insertStatement(db, coursePackId, 1);
    await insertStatement(db, coursePackId, 2);
    await insertUserCourseProgress(db, coursePackId, 0);
    await db.insert(courseHistory).values({ coursePackId, completionCount: 1 });

    return agent
      .delete(`/course-pack/${coursePackId}`)
      .expect(200)
      .expect(async ({ body }) => {
        expect(body).toEqual({ deleted: true, coursePackId });

        expect(
          await db.query.coursePack.findFirst({ where: eq(coursePack.id, coursePackId) }),
        ).toBeUndefined();
        expect(
          await db.query.statement.findMany({ where: eq(statement.coursePackId, coursePackId) }),
        ).toHaveLength(0);
        expect(
          await db.query.courseHistory.findMany({
            where: eq(courseHistory.coursePackId, coursePackId),
          }),
        ).toHaveLength(0);
      });
  });

  it("delete: /course-pack/:coursePackId with unknown id returns 404", async () => {
    return agent.delete(`/course-pack/${createId()}`).expect(404);
  });

  it("get: /course-pack/:coursePackId/edit returns video, statements and timings (no progress)", async () => {
    const { id: coursePackId } = await insertCoursePack(db, {
      title: "待编辑",
      description: "原描述",
      cover: "cover.png",
      video: "course-video/e2e.mp4",
    });
    await insertStatement(db, coursePackId, 2, {
      english: "two",
      chinese: "二",
      soundmark: "/2/",
      startTime: 3,
      endTime: 4,
    });
    await insertStatement(db, coursePackId, 1, { english: "one", chinese: "一", soundmark: "/1/" });

    return agent
      .get(`/course-pack/${coursePackId}/edit`)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({
          title: "待编辑",
          description: "原描述",
          cover: "cover.png",
          video: "course-video/e2e.mp4",
          statements: [
            { english: "one", chinese: "一", phonetic: "/1/" },
            { english: "two", chinese: "二", phonetic: "/2/", startTime: 3, endTime: 4 },
          ],
        });
        expect(body).not.toHaveProperty("statementIndex");
      });
  });

  it("post: /course-pack/video without a file returns 400", async () => {
    return agent.post("/course-pack/video").expect(400);
  });

  it("post: /course-pack/video with unsupported extension returns 400", async () => {
    return agent
      .post("/course-pack/video")
      .attach("videoFile", Buffer.from("not-a-video"), "notes.txt")
      .expect(400);
  });

  it("patch: /course-pack/:coursePackId updates meta and rebuilds statements", async () => {
    const { id: coursePackId } = await insertCoursePack(db, { title: "旧标题" });
    await insertStatement(db, coursePackId, 1, {
      english: "old",
    });
    await insertStatement(db, coursePackId, 2, { english: "to-delete" });

    return agent
      .patch(`/course-pack/${coursePackId}`)
      .send({
        title: "新标题",
        description: "新描述",
        cover: "new.png",
        courses: {
          statements: [
            { english: "alpha", chinese: "甲", phonetic: "/a/" },
            { english: "beta", chinese: "乙" },
          ],
        },
      })
      .expect(200)
      .expect(async ({ body }) => {
        expect(body.coursePackId).toBe(coursePackId);

        const pack = await db.query.coursePack.findFirst({
          where: eq(coursePack.id, coursePackId),
        });
        expect(pack?.title).toBe("新标题");
        expect(pack?.description).toBe("新描述");
        expect(pack?.cover).toBe("new.png");

        const statements = await db.query.statement.findMany({
          where: eq(statement.coursePackId, coursePackId),
          orderBy: (table, { asc }) => [asc(table.order)],
        });
        expect(statements).toHaveLength(2);
        expect(statements[0]!.english).toBe("alpha");
        expect(statements[0]!.soundmark).toBe("/a/");
        expect(statements[1]!.english).toBe("beta");
        expect(statements.map((s) => s.english)).not.toContain("old");
        expect(statements.map((s) => s.english)).not.toContain("to-delete");
      });
  });

  it("patch: /course-pack/:coursePackId with unknown id returns 404", async () => {
    return agent
      .patch(`/course-pack/${createId()}`)
      .send({ title: "x", courses: { statements: [{ english: "a", chinese: "甲" }] } })
      .expect(404);
  });

  it("patch: /course-pack/:coursePackId with invalid payload returns 400", async () => {
    const { id: coursePackId } = await insertCoursePack(db);
    return agent
      .patch(`/course-pack/${coursePackId}`)
      .send({ title: "", courses: { statements: [] } })
      .expect(400);
  });

  it("get: /course-pack/:coursePackId returns pack with completionCount", async () => {
    const { id: coursePackId } = await insertCoursePack(db);
    await db.insert(courseHistory).values({ coursePackId, completionCount: 3 });

    return agent
      .get(`/course-pack/${coursePackId}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.id).toBe(coursePackId);
        expect(body).toHaveProperty("order");
        expect(body).toHaveProperty("title");
        expect(body.completionCount).toBe(3);
        expect(body).not.toHaveProperty("courses");
      });
  });

  it("get: /course-pack/:coursePackId/learning returns statements with progress", async () => {
    const { id: coursePackId } = await insertCoursePack(db);
    await insertStatement(db, coursePackId, 1);
    await insertStatement(db, coursePackId, 2);
    await insertUserCourseProgress(db, coursePackId, 1);

    return agent
      .get(`/course-pack/${coursePackId}/learning`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.id).toBe(coursePackId);
        expect(body.statements).toHaveLength(2);
        expect(body.statementIndex).toBe(1);
      });
  });

  it("post: /course-pack/:coursePackId/complete records a pack completion", async () => {
    const { id: coursePackId } = await insertCoursePack(db);

    return agent
      .post(`/course-pack/${coursePackId}/complete`)
      .expect(201)
      .expect(async () => {
        const record = await db.query.courseHistory.findFirst({
          where: eq(courseHistory.coursePackId, coursePackId),
        });
        expect(record?.completionCount).toBe(1);
      });
  });

  it("post: /course-pack/:coursePackId/complete with unknown id returns 404", async () => {
    return agent.post(`/course-pack/${createId()}/complete`).expect(404);
  });
});

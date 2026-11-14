import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { cleanDB } from "../../../test/helper/utils";
import { AppModule } from "../../app/app.module";
import { appGlobalMiddleware } from "../../app/useGlobal";
import { endDB } from "../../common/db";
import { DB, DbType } from "../../global/providers/db.provider";

// e2e 专用音频目录：在应用创建前设置，使 useGlobal 挂载该目录服务 /course-audio
const testCourseAudioDir = join(tmpdir(), "earthworm-course-audio-e2e");
process.env.COURSE_AUDIO_DIR = testCourseAudioDir;

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
        courses: {
          title: "第一课",
          description: "",
          statements: [
            {
              english: "How are you?",
              chinese: "你好吗？",
              phonetic: "",
              audioUrl: "/course-audio/how-are-you.mp3",
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

        const withAudio = statements.find((s) => s.english === "How are you?");
        expect(withAudio?.audioUrl).toBe("/course-audio/how-are-you.mp3");

        const withoutAudio = statements.find((s) => s.english === "I am fine.");
        expect(withoutAudio?.audioUrl).toBeNull();
      });
  });

  it("post: /course-pack with invalid payload returns 400", async () => {
    return request(app.getHttpServer())
      .post("/course-pack")
      .send({ title: "", courses: { statements: [] } })
      .expect(400);
  });

  it("post: /course-pack persists video and statement timings", async () => {
    const words = [
      { word: "How", start: 1, end: 1.3 },
      { word: "are", start: 1.3, end: 1.6 },
      { word: "you", start: 1.6, end: 2 },
    ];
    const { body } = await request(app.getHttpServer())
      .post("/course-pack")
      .send({
        title: "视频课程",
        video: "/course-video/20261113-120000.mp4",
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
    expect(pack?.video).toBe("/course-video/20261113-120000.mp4");

    const statements = await db.query.statement.findMany({
      where: eq(statement.coursePackId, body.coursePackId),
      orderBy: (table, { asc }) => [asc(table.order)],
    });
    expect(statements[0]!.startTime).toBe(1);
    expect(statements[0]!.endTime).toBe(2);
    expect(statements[0]!.words).toEqual(words);
    expect(statements[1]!.startTime).toBeNull();
    expect(statements[1]!.words).toBeNull();

    // learning 接口原样带出新字段
    await request(app.getHttpServer())
      .get(`/course-pack/${body.coursePackId}/learning`)
      .expect(200)
      .expect(({ body: learning }) => {
        expect(learning.video).toBe("/course-video/20261113-120000.mp4");
        expect(learning.statements[0].startTime).toBe(1);
        expect(learning.statements[0].words).toEqual(words);
      });
  });

  it("patch: /course-pack/:coursePackId keeps timings only for unchanged english", async () => {
    const words = [{ word: "old", start: 0, end: 0.5 }];
    const { id: coursePackId } = await insertCoursePack(db, { video: "/course-video/v.mp4" });
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

    await request(app.getHttpServer())
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
    expect(pack?.video).toBe("/course-video/v.mp4");
  });

  it("get: /course-audio/:file serves stored audio clips", async () => {
    const clipBytes = Buffer.from("fake-mp3-bytes-for-e2e");
    const fileName = "e2e-clip.mp3";
    try {
      await request(app.getHttpServer()).get(`/course-audio/${fileName}`).expect(404);

      await mkdir(testCourseAudioDir, { recursive: true });
      await writeFile(join(testCourseAudioDir, fileName), clipBytes);

      await request(app.getHttpServer())
        .get(`/course-audio/${fileName}`)
        .expect(200)
        .expect((res) => {
          expect(res.body).toEqual(clipBytes);
        });
    } finally {
      await rm(testCourseAudioDir, { recursive: true, force: true });
    }
  });

  it("delete: /course-pack/:coursePackId removes pack with its statements and progress", async () => {
    const { id: coursePackId } = await insertCoursePack(db);
    await insertStatement(db, coursePackId, 1);
    await insertStatement(db, coursePackId, 2);
    await insertUserCourseProgress(db, coursePackId, 0);
    await db.insert(courseHistory).values({ coursePackId, completionCount: 1 });

    return request(app.getHttpServer())
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
    return request(app.getHttpServer()).delete(`/course-pack/${createId()}`).expect(404);
  });

  it("get: /course-pack/:coursePackId/edit returns pack meta and statements (no progress)", async () => {
    const { id: coursePackId } = await insertCoursePack(db, {
      title: "待编辑",
      description: "原描述",
      cover: "cover.png",
    });
    await insertStatement(db, coursePackId, 2, { english: "two", chinese: "二", soundmark: "/2/" });
    await insertStatement(db, coursePackId, 1, { english: "one", chinese: "一", soundmark: "/1/" });

    return request(app.getHttpServer())
      .get(`/course-pack/${coursePackId}/edit`)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({
          title: "待编辑",
          description: "原描述",
          cover: "cover.png",
          statements: [
            { english: "one", chinese: "一", phonetic: "/1/" },
            { english: "two", chinese: "二", phonetic: "/2/" },
          ],
        });
        expect(body).not.toHaveProperty("statementIndex");
      });
  });

  it("patch: /course-pack/:coursePackId updates meta and rebuilds statements", async () => {
    const { id: coursePackId } = await insertCoursePack(db, { title: "旧标题" });
    await insertStatement(db, coursePackId, 1, {
      english: "old",
      audioUrl: "/course-audio/old.mp3",
    });
    await insertStatement(db, coursePackId, 2, { english: "to-delete" });

    return request(app.getHttpServer())
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
        expect(statements[0]!.audioUrl).toBeNull();
        expect(statements[1]!.english).toBe("beta");
        expect(statements.map((s) => s.english)).not.toContain("old");
        expect(statements.map((s) => s.english)).not.toContain("to-delete");
      });
  });

  it("patch: /course-pack/:coursePackId with unknown id returns 404", async () => {
    return request(app.getHttpServer())
      .patch(`/course-pack/${createId()}`)
      .send({ title: "x", courses: { statements: [{ english: "a", chinese: "甲" }] } })
      .expect(404);
  });

  it("patch: /course-pack/:coursePackId with invalid payload returns 400", async () => {
    const { id: coursePackId } = await insertCoursePack(db);
    return request(app.getHttpServer())
      .patch(`/course-pack/${coursePackId}`)
      .send({ title: "", courses: { statements: [] } })
      .expect(400);
  });

  it("get: /course-pack/:coursePackId returns pack with completionCount", async () => {
    const { id: coursePackId } = await insertCoursePack(db);
    await db.insert(courseHistory).values({ coursePackId, completionCount: 3 });

    return request(app.getHttpServer())
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

    return request(app.getHttpServer())
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

    return request(app.getHttpServer())
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
    return request(app.getHttpServer()).post(`/course-pack/${createId()}/complete`).expect(404);
  });
});

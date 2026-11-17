import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import * as request from "supertest";

import { createAuthedAgent } from "../../../test/helper/utils";
import { AppModule } from "../../app/app.module";
import { appGlobalMiddleware } from "../../app/useGlobal";
import { endDB } from "../../common/db";

describe("auth e2e", () => {
  let app: INestApplication;
  let credentials: { username: string; password: string };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    appGlobalMiddleware(app);
    await app.init();

    const config = app.get(ConfigService);
    credentials = {
      username: config.getOrThrow<string>("AUTH_USERNAME"),
      password: config.getOrThrow<string>("AUTH_PASSWORD"),
    };
  });

  afterAll(async () => {
    await endDB();
    await app.close();
  });

  it("post: /auth/login with wrong password returns 401", async () => {
    await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username: credentials.username, password: "wrong-password" })
      .expect(401);
  });

  it("post: /auth/login with invalid payload returns 400", async () => {
    await request(app.getHttpServer()).post("/auth/login").send({ username: "" }).expect(400);
  });

  it("blocks unauthenticated api, static audio and swagger requests", async () => {
    await request(app.getHttpServer()).get("/course-pack").expect(401);
    await request(app.getHttpServer()).get("/course-audio/whatever.mp3").expect(401);
    await request(app.getHttpServer()).get("/course-video/whatever.mp4").expect(401);
    await request(app.getHttpServer()).get("/swagger").expect(401);
    await request(app.getHttpServer()).get("/auth/me").expect(401);
  });

  it("rejects a tampered cookie", async () => {
    await request(app.getHttpServer())
      .get("/auth/me")
      .set("Cookie", "auth_token=eyJ1IjoiYWRtaW4ifQ.forged-signature")
      .expect(401);
  });

  it("login sets an httpOnly cookie, grants access, and logout revokes it", async () => {
    const agent = request.agent(app.getHttpServer());
    const res = await agent.post("/auth/login").send(credentials).expect(201);

    const setCookie = res.headers["set-cookie"][0];
    expect(setCookie).toContain("auth_token=");
    expect(setCookie).toContain("HttpOnly");
    expect(res.body).toEqual({ username: credentials.username });

    await agent.get("/auth/me").expect(200).expect({ username: credentials.username });
    await agent.get("/course-pack").expect(200);

    await agent.post("/auth/logout").expect(201);
    await agent.get("/auth/me").expect(401);
    await agent.get("/course-pack").expect(401);
  });

  it("createAuthedAgent helper works for other e2e specs", async () => {
    const agent = await createAuthedAgent(app);
    await agent.get("/auth/me").expect(200);
  });
});

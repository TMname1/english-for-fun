import fs from "node:fs";
import fsp from "node:fs/promises";
import { join } from "node:path";

import { BadRequestException, NotFoundException } from "@nestjs/common";

import type { StorageService } from "../../storage/storage.service";
import { ForgeService } from "../forge.service";
import { JobStore } from "../job-store";
import { spawnForgeRunner } from "../runner-client";

jest.mock("../runner-client", () => ({
  spawnForgeRunner: jest.fn(() => ({ child: {}, pid: 1, kill: jest.fn() })),
  FORGE_OUTPUT_ROOT: "/tmp/forge-output",
}));

const mockSpawn = jest.mocked(spawnForgeRunner);

function fileOf(name: string): Express.Multer.File {
  return { filename: name, path: `/tmp/uploads/${name}` } as Express.Multer.File;
}

function createStorageMock() {
  return {
    uploadFile: jest.fn(async () => {}),
    downloadToFile: jest.fn(async () => {}),
    getBuffer: jest.fn(async (_key: string): Promise<Buffer | null> => null),
    putBuffer: jest.fn(async () => {}),
    presignGet: jest.fn(async (key: string) => `https://oss.test/${key}?sig`),
    deleteObject: jest.fn(async () => {}),
  };
}

/** fake timers 下把 async 链（mkdir/downloadToFile 等 mock）冲刷到 spawn 调用点 */
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const baseDto = { title: "测试课程", type: "dialogue" as const };

describe("ForgeService（视频切片两段式启动 + 对象存储）", () => {
  let store: JobStore;
  let service: ForgeService;
  let storage: ReturnType<typeof createStorageMock>;

  beforeEach(() => {
    jest.useFakeTimers();
    mockSpawn.mockClear();
    storage = createStorageMock();
    store = new JobStore(storage as unknown as StorageService);
    service = new ForgeService(store, storage as unknown as StorageService);

    jest.spyOn(fs, "existsSync").mockReturnValue(false);
    jest.spyOn(fsp, "mkdir").mockResolvedValue(undefined);
    jest.spyOn(fsp, "rm").mockResolvedValue(undefined);
    jest.spyOn(fsp, "readFile").mockResolvedValue(Buffer.from("{}") as never);
    jest.spyOn(fsp, "writeFile").mockResolvedValue(undefined);
  });

  afterEach(() => {
    store.onModuleDestroy();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("defer=true 上传视频到 OSS、删临时文件，只建 pending 记录不启动子进程", async () => {
    const { jobId } = await service.createJob(fileOf("a.mp4"), { ...baseDto, defer: true });

    expect(storage.uploadFile).toHaveBeenCalledWith("course-video/a.mp4", "/tmp/uploads/a.mp4");
    expect(fsp.rm).toHaveBeenCalledWith("/tmp/uploads/a.mp4", { force: true });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(store.get(jobId)!.status).toBe("pending");
    expect(store.get(jobId)!.videoKey).toBe("course-video/a.mp4");
  });

  it("上传 OSS 失败时抛错且仍清理临时文件，不建任务", async () => {
    storage.uploadFile.mockRejectedValueOnce(new Error("oss down"));

    await expect(service.createJob(fileOf("a.mp4"), baseDto)).rejects.toThrow("oss down");
    expect(fsp.rm).toHaveBeenCalledWith("/tmp/uploads/a.mp4", { force: true });
    expect(store.get("a")).toBeUndefined();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("multipart 字符串 'true' 也识别为 defer；'false' 正常启动", async () => {
    const a = await service.createJob(fileOf("a.mp4"), { ...baseDto, defer: "true" } as any);
    expect(store.get(a.jobId)!.status).toBe("pending");

    const b = await service.createJob(fileOf("b.mp4"), { ...baseDto, defer: "false" } as any);
    await flush();
    expect(store.get(b.jobId)!.status).toBe("running");
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("无 defer：先把视频从 OSS 拉到本地临时工作区，再启动子进程", async () => {
    const { jobId } = await service.createJob(fileOf("a.mp4"), baseDto);
    await flush();

    expect(store.get(jobId)!.status).toBe("running");
    expect(storage.downloadToFile).toHaveBeenCalledWith(
      "course-video/a.mp4",
      join("/tmp/forge-output", "a", "source.mp4"),
    );
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn.mock.calls[0][0].clips).toBeUndefined();
    expect(mockSpawn.mock.calls[0][0].mediaPath).toBe(join("/tmp/forge-output", "a", "source.mp4"));
  });

  it("拉取视频失败 → 任务 failed，不启动子进程", async () => {
    storage.downloadToFile.mockRejectedValueOnce(new Error("no such object"));

    const { jobId } = await service.createJob(fileOf("a.mp4"), baseDto);
    await flush();

    expect(store.get(jobId)!.status).toBe("failed");
    expect(store.get(jobId)!.error).toContain("准备转写失败");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("startTranscription 校验 clips 并透传给 runner；getJob 返回预签名 URL 与对象键", async () => {
    const { jobId } = await service.createJob(fileOf("a.mp4"), { ...baseDto, defer: true });
    const clips = [
      { start: 0, end: 5 },
      { start: 12, end: 20 },
    ];
    service.startTranscription(jobId, { clips });
    await flush();

    expect(store.get(jobId)!.status).toBe("running");
    expect(mockSpawn.mock.calls[0][0].clips).toEqual(clips);

    const view = await service.getJob(jobId);
    expect(view.clips).toEqual(clips);
    expect(view.videoKey).toBe("course-video/a.mp4");
    expect(view.videoPath).toBe("https://oss.test/course-video/a.mp4?sig");
  });

  it("clips 缺省时整段转写（runner 不带 clips）", async () => {
    const { jobId } = await service.createJob(fileOf("a.mp4"), { ...baseDto, defer: true });
    service.startTranscription(jobId, {});
    await flush();
    expect(mockSpawn.mock.calls[0][0].clips).toBeUndefined();
  });

  it("非法 clips 返回 400：空数组 / 过短 / 超过 5 分钟 / 乱序重叠", async () => {
    const { jobId } = await service.createJob(fileOf("a.mp4"), { ...baseDto, defer: true });
    expect(() => service.startTranscription(jobId, { clips: [] })).toThrow(BadRequestException);
    expect(() => service.startTranscription(jobId, { clips: [{ start: 1, end: 1.05 }] })).toThrow(
      BadRequestException,
    );
    expect(() => service.startTranscription(jobId, { clips: [{ start: 0, end: 301 }] })).toThrow(
      BadRequestException,
    );
    expect(() =>
      service.startTranscription(jobId, {
        clips: [
          { start: 10, end: 20 },
          { start: 5, end: 12 },
        ],
      }),
    ).toThrow(BadRequestException);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(store.get(jobId)!.status).toBe("pending");
  });

  it("恰好 5 分钟的 clip 允许提交", async () => {
    const { jobId } = await service.createJob(fileOf("a.mp4"), { ...baseDto, defer: true });
    expect(() =>
      service.startTranscription(jobId, { clips: [{ start: 0, end: 300 }] }),
    ).not.toThrow();
  });

  it("不存在的任务 404；非 pending 状态 400", async () => {
    expect(() => service.startTranscription("nope", {})).toThrow(NotFoundException);
    const { jobId } = await service.createJob(fileOf("a.mp4"), baseDto);
    expect(() => service.startTranscription(jobId, {})).toThrow(BadRequestException);
  });

  it("pending 任务可取消", async () => {
    const { jobId } = await service.createJob(fileOf("a.mp4"), { ...baseDto, defer: true });
    expect(service.cancelJob(jobId)).toEqual({ cancelled: true });
    expect(store.get(jobId)!.status).toBe("cancelled");
  });

  it("pending 超过 2 小时未 start：记录与 OSS 视频一起清理", async () => {
    const { jobId } = await service.createJob(fileOf("a.mp4"), { ...baseDto, defer: true });

    jest.advanceTimersByTime(2 * 60 * 60 * 1000 + 30 * 60 * 1000);
    await flush();

    expect(store.get(jobId)).toBeUndefined();
    expect(storage.deleteObject).toHaveBeenCalledWith("course-video/a.mp4");
  });

  it("转写完成：JSON 产物上传 forge/<id>/、清理临时区、进入 awaiting_review；getJob 从 OSS 读转录", async () => {
    const transcript = { segments: [{ text: "hello", start: 0, end: 1 }] };
    jest.spyOn(fs, "existsSync").mockImplementation((p) => String(p).endsWith("transcript.json"));
    jest.spyOn(fsp, "readFile").mockResolvedValue(Buffer.from(JSON.stringify(transcript)) as never);

    const { jobId } = await service.createJob(fileOf("a.mp4"), baseDto);
    await flush();
    mockSpawn.mock.calls[0][1].onDone(join("/tmp/forge-output", "a"));
    await flush();

    expect(storage.putBuffer).toHaveBeenCalledWith(
      "forge/a/transcript.json",
      expect.any(Buffer),
      "application/json",
    );
    expect(fsp.rm).toHaveBeenCalledWith(join("/tmp/forge-output", "a"), {
      recursive: true,
      force: true,
    });
    expect(store.get(jobId)!.status).toBe("awaiting_review");

    storage.getBuffer.mockImplementation(async (key: string) =>
      key === "forge/a/transcript.json" ? Buffer.from(JSON.stringify(transcript)) : null,
    );
    const view = await service.getJob(jobId);
    expect(view.transcriptJson).toEqual(transcript);
  });

  it("resumeJob：edited 写 OSS，拉回产物到临时区，起 structure 子进程", async () => {
    const { jobId } = await service.createJob(fileOf("a.mp4"), { ...baseDto, defer: true });
    store.update(jobId, { status: "awaiting_review" });
    storage.getBuffer.mockImplementation(async (key: string) =>
      key.startsWith("forge/a/") ? Buffer.from("{}") : null,
    );

    await service.resumeJob(jobId, {
      segments: [{ text: "hello", start: 0, end: 1 }],
    } as any);

    expect(storage.putBuffer).toHaveBeenCalledWith(
      "forge/a/transcript.edited.json",
      expect.any(Buffer),
      "application/json",
    );
    for (const name of ["meta.json", "transcript.json", "clips.json", "transcript.edited.json"]) {
      expect(storage.getBuffer).toHaveBeenCalledWith(`forge/a/${name}`);
      expect(fsp.writeFile).toHaveBeenCalledWith(
        join("/tmp/forge-output", "a", name),
        expect.any(Buffer),
      );
    }
    expect(store.get(jobId)!.status).toBe("running");
    expect(mockSpawn.mock.calls[0][0].phase).toBe("structure");
  });

  it("resumeJob：非 awaiting_review 状态 400；空 segments 400", async () => {
    const { jobId } = await service.createJob(fileOf("a.mp4"), { ...baseDto, defer: true });
    await expect(service.resumeJob(jobId, { segments: [{ text: "x" }] } as any)).rejects.toThrow(
      BadRequestException,
    );

    store.update(jobId, { status: "awaiting_review" });
    await expect(service.resumeJob(jobId, { segments: [] } as any)).rejects.toThrow(
      BadRequestException,
    );
  });
});

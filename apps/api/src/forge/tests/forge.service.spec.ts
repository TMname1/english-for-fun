import { BadRequestException, NotFoundException } from "@nestjs/common";

import { ForgeService } from "../forge.service";
import { JobStore } from "../job-store";
import { spawnForgeRunner } from "../runner-client";

jest.mock("../runner-client", () => ({
  spawnForgeRunner: jest.fn(() => ({ child: {}, pid: 1, kill: jest.fn() })),
  COURSE_VIDEO_DIR: "/tmp/course-video",
  FORGE_OUTPUT_ROOT: "/tmp/forge-output",
}));

const mockSpawn = jest.mocked(spawnForgeRunner);

function fileOf(name: string): Express.Multer.File {
  return { filename: name } as Express.Multer.File;
}

const baseDto = { title: "测试课程", type: "dialogue" as const };

describe("ForgeService（视频切片两段式启动）", () => {
  let store: JobStore;
  let service: ForgeService;

  beforeEach(() => {
    jest.useFakeTimers();
    mockSpawn.mockClear();
    store = new JobStore();
    service = new ForgeService(store);
  });

  afterEach(() => {
    store.onModuleDestroy();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("defer=true 只建 pending 记录，不启动子进程", () => {
    const { jobId } = service.createJob(fileOf("a.mp4"), { ...baseDto, defer: true });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(store.get(jobId)!.status).toBe("pending");
  });

  it("multipart 字符串 'true' 也识别为 defer；'false' 正常启动", () => {
    const a = service.createJob(fileOf("a.mp4"), {
      ...baseDto,
      defer: "true",
    } as any);
    expect(store.get(a.jobId)!.status).toBe("pending");

    const b = service.createJob(fileOf("b.mp4"), {
      ...baseDto,
      defer: "false",
    } as any);
    expect(store.get(b.jobId)!.status).toBe("running");
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("无 defer 保持原行为：立即启动子进程", () => {
    const { jobId } = service.createJob(fileOf("a.mp4"), baseDto);
    expect(store.get(jobId)!.status).toBe("running");
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn.mock.calls[0][0].clips).toBeUndefined();
  });

  it("startTranscription 校验 clips 并透传给 runner", async () => {
    const { jobId } = service.createJob(fileOf("a.mp4"), { ...baseDto, defer: true });
    const clips = [
      { start: 0, end: 5 },
      { start: 12, end: 20 },
    ];
    service.startTranscription(jobId, { clips });
    expect(store.get(jobId)!.status).toBe("running");
    expect(mockSpawn.mock.calls[0][0].clips).toEqual(clips);

    const view = await service.getJob(jobId);
    expect(view.clips).toEqual(clips);
    expect(view.videoPath).toBe("/course-video/a.mp4");
  });

  it("clips 缺省时整段转写（runner 不带 clips）", () => {
    const { jobId } = service.createJob(fileOf("a.mp4"), { ...baseDto, defer: true });
    service.startTranscription(jobId, {});
    expect(mockSpawn.mock.calls[0][0].clips).toBeUndefined();
  });

  it("非法 clips 返回 400：空数组 / 过短 / 超过 5 分钟 / 乱序重叠", () => {
    const { jobId } = service.createJob(fileOf("a.mp4"), { ...baseDto, defer: true });
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

  it("恰好 5 分钟的 clip 允许提交", () => {
    const { jobId } = service.createJob(fileOf("a.mp4"), { ...baseDto, defer: true });
    expect(() =>
      service.startTranscription(jobId, { clips: [{ start: 0, end: 300 }] }),
    ).not.toThrow();
  });

  it("不存在的任务 404；非 pending 状态 400", () => {
    expect(() => service.startTranscription("nope", {})).toThrow(NotFoundException);
    const { jobId } = service.createJob(fileOf("a.mp4"), baseDto);
    expect(() => service.startTranscription(jobId, {})).toThrow(BadRequestException);
  });

  it("pending 任务可取消", () => {
    const { jobId } = service.createJob(fileOf("a.mp4"), { ...baseDto, defer: true });
    expect(service.cancelJob(jobId)).toEqual({ cancelled: true });
    expect(store.get(jobId)!.status).toBe("cancelled");
  });
});

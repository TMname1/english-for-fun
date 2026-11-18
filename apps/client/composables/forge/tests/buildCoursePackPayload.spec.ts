import { describe, expect, it } from "vitest";

import type { ForgeJobView } from "~/api/forge";
import { buildCoursePackPayload } from "../buildCoursePackPayload";

function jobOf(overrides: Partial<ForgeJobView> = {}): ForgeJobView {
  return {
    id: "job-1",
    status: "done",
    stage: "done",
    message: "已完成",
    elapsedMs: 1000,
    outDir: "/tmp/forge-output/job-1",
    videoPath: "https://oss.test/earthworm/course-video/job-1.mp4?X-Amz-Signature=abc",
    videoKey: "course-video/job-1.mp4",
    title: "任务标题",
    type: "dialogue",
    courseJson: {
      title: "产物标题",
      description: "产物描述",
      cover: "",
      courses: {
        title: "产物标题",
        statements: [
          {
            english: "Hello",
            chinese: "你好",
            phonetic: "/həˈloʊ/",
            startTime: 0,
            endTime: 1,
            words: [{ word: "Hello", start: 0, end: 1 }],
          },
        ],
      },
    },
    ...overrides,
  };
}

describe("buildCoursePackPayload", () => {
  it("stores the object key (videoKey), never the expiring presigned videoPath", () => {
    const payload = buildCoursePackPayload(jobOf());

    expect(payload.video).toBe("course-video/job-1.mp4");
    expect(payload.title).toBe("产物标题");
    expect(payload.courses.statements[0]).toEqual({
      english: "Hello",
      chinese: "你好",
      phonetic: "/həˈloʊ/",
      startTime: 0,
      endTime: 1,
      words: [{ word: "Hello", start: 0, end: 1 }],
    });
  });

  it("leaves video undefined when the job has no object key", () => {
    const payload = buildCoursePackPayload(jobOf({ videoKey: "" }));
    expect(payload.video).toBeUndefined();
  });

  it("throws when courseJson is missing or statements are empty", () => {
    expect(() => buildCoursePackPayload(jobOf({ courseJson: undefined }))).toThrow("产物缺失");
    expect(() =>
      buildCoursePackPayload(
        jobOf({
          courseJson: {
            title: "t",
            description: "",
            cover: "",
            courses: { title: "t", statements: [] },
          },
        }),
      ),
    ).toThrow("句子列表为空");
  });
});

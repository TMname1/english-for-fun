import { describe, expect, it } from "vitest";

import { isAudioSource, mediaKindFromFile, resolveMediaKind } from "../media";

describe("isAudioSource", () => {
  it("识别对象键与普通文件名中的音频扩展名", () => {
    expect(isAudioSource("course-video/abc.mp3")).toBe(true);
    expect(isAudioSource("song.m4a")).toBe(true);
    expect(isAudioSource("podcast.WAV")).toBe(true);
    expect(isAudioSource("voice.aac")).toBe(true);
  });

  it("识别带签名参数的预签名 URL（query 不影响扩展名判定）", () => {
    expect(
      isAudioSource(
        "https://oss.test/course-video/abc.mp3?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef",
      ),
    ).toBe(true);
    expect(isAudioSource("https://oss.test/course-video/abc.mp4?sig=1#t=3")).toBe(false);
  });

  it("视频与无扩展名资源都按视频处理", () => {
    expect(isAudioSource("course-video/abc.mp4")).toBe(false);
    expect(isAudioSource("course-video/abc.mkv")).toBe(false);
    expect(isAudioSource("https://www.bilibili.com/video/BV1xx411c7mD")).toBe(false);
    expect(isAudioSource("")).toBe(false);
    expect(isAudioSource(null)).toBe(false);
    expect(isAudioSource(undefined)).toBe(false);
  });

  it("目录名里的点不会被误判成扩展名", () => {
    expect(isAudioSource("media.v2/clip")).toBe(false);
  });
});

describe("resolveMediaKind", () => {
  it("服务端给出的 mediaKind 优先", () => {
    expect(resolveMediaKind("audio", "course-video/x.mp4")).toBe("audio");
    expect(resolveMediaKind("video", "course-video/x.mp3")).toBe("video");
  });

  it("缺省时回退到资源扩展名，仍判不出来则按视频", () => {
    expect(resolveMediaKind(undefined, "course-video/x.mp3")).toBe("audio");
    expect(resolveMediaKind(null, "course-video/x.mp4")).toBe("video");
    expect(resolveMediaKind(undefined, "")).toBe("video");
  });
});

describe("mediaKindFromFile", () => {
  it("优先按 MIME 判断，MIME 缺失时回退扩展名", () => {
    expect(mediaKindFromFile(new File(["x"], "recording", { type: "audio/webm" }))).toBe("audio");
    expect(mediaKindFromFile(new File(["x"], "clip.mp4", { type: "video/mp4" }))).toBe("video");
    expect(mediaKindFromFile(new File(["x"], "song.mp3", { type: "" }))).toBe("audio");
    // 部分系统给不出 MIME 也认不出扩展名时按视频，与服务端 mediaKindOf 保持一致
    expect(mediaKindFromFile(new File(["x"], "unknown", { type: "" }))).toBe("video");
  });
});

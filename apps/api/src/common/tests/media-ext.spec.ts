import { isAllowedMediaExt, mediaKindOf } from "../media-ext";

describe("media-ext", () => {
  describe("mediaKindOf", () => {
    it("识别音频扩展名（对象键、预签名 URL、文件名都适用）", () => {
      expect(mediaKindOf("course-video/a.mp3")).toBe("audio");
      expect(mediaKindOf("course-video/a.m4a")).toBe("audio");
      expect(mediaKindOf("course-video/A.WAV")).toBe("audio");
      expect(mediaKindOf("course-video/a.aac")).toBe("audio");
      expect(mediaKindOf("https://oss.test/course-video/a.mp3?X-Amz-Signature=abc#t=1")).toBe(
        "audio",
      );
    });

    it("其余一律按视频处理（历史数据、外链、空值、无扩展名）", () => {
      expect(mediaKindOf("course-video/a.mp4")).toBe("video");
      expect(mediaKindOf("course-video/a.mkv")).toBe("video");
      expect(mediaKindOf("https://www.bilibili.com/video/BV1xx411c7mD")).toBe("video");
      expect(mediaKindOf("course-video/media.v2/clip")).toBe("video");
      expect(mediaKindOf("")).toBe("video");
      expect(mediaKindOf(null)).toBe("video");
      expect(mediaKindOf(undefined)).toBe("video");
    });
  });

  describe("isAllowedMediaExt", () => {
    it("放行视频与音频扩展名", () => {
      for (const ext of [".mp4", ".mov", ".mp3", ".m4a", ".wav", ".aac"]) {
        expect(isAllowedMediaExt(ext)).toBe(true);
      }
      expect(isAllowedMediaExt(".MP3")).toBe(true);
    });

    it("拒绝非媒体扩展名", () => {
      for (const ext of [".txt", ".json", ".ogg", ".flac", ""]) {
        expect(isAllowedMediaExt(ext)).toBe(false);
      }
    });
  });
});

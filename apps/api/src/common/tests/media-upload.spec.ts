import { BadRequestException } from "@nestjs/common";

import type { StorageService } from "../../storage/storage.service";
import { assertMediaObjectKey, presignMediaUpload, verifyUploadedMedia } from "../media-upload";

function createStorageMock() {
  return {
    presignPut: jest.fn(async (key: string) => `https://oss.test/${key}?put-sig`),
    presignPutExpiresSeconds: 600,
    headObject: jest.fn(
      async (_key: string): Promise<{ size: number; contentType?: string } | null> => ({
        size: 2048,
        contentType: "audio/mpeg",
      }),
    ),
    deleteObject: jest.fn(async () => {}),
  };
}

type StorageMock = ReturnType<typeof createStorageMock>;
const asStorage = (mock: StorageMock) => mock as unknown as StorageService;

describe("common/media-upload", () => {
  describe("presignMediaUpload", () => {
    it("生成 course-video/<uuid><ext>，并把 PUT URL 与有效期一起返回", async () => {
      const storage = createStorageMock();
      const ticket = await presignMediaUpload(asStorage(storage), "素材.MP4");

      expect(ticket.key).toMatch(/^course-video\/[0-9a-f-]{36}\.mp4$/);
      expect(ticket.uploadUrl).toBe(`https://oss.test/${ticket.key}?put-sig`);
      expect(ticket.expiresInSeconds).toBe(600);
    });

    it("白名单外扩展名 400，且不签发 URL", async () => {
      const storage = createStorageMock();
      await expect(presignMediaUpload(asStorage(storage), "note.txt")).rejects.toThrow(
        BadRequestException,
      );
      expect(storage.presignPut).not.toHaveBeenCalled();
    });
  });

  describe("assertMediaObjectKey", () => {
    it("放过合法键", () => {
      const key = "course-video/11111111-1111-1111-1111-111111111111.mp3";
      expect(assertMediaObjectKey(`  ${key}  `)).toBe(key);
    });

    it("拒绝跨前缀、路径穿越、非白名单扩展名", () => {
      for (const key of [
        "",
        "tts/a.mp3",
        "course-video/../etc/passwd.mp4",
        "course-video/a.txt",
        "course-video",
      ]) {
        expect(() => assertMediaObjectKey(key)).toThrow(BadRequestException);
      }
    });
  });

  describe("verifyUploadedMedia", () => {
    it("对象存在时返回键与大小", async () => {
      const storage = createStorageMock();
      const key = "course-video/22222222-2222-2222-2222-222222222222.mp4";
      await expect(verifyUploadedMedia(asStorage(storage), key)).resolves.toEqual({
        key,
        size: 2048,
      });
    });

    it("对象不存在（直传没完成）400", async () => {
      const storage = createStorageMock();
      storage.headObject.mockResolvedValueOnce(null);

      await expect(
        verifyUploadedMedia(
          asStorage(storage),
          "course-video/33333333-3333-3333-3333-333333333333.mp4",
        ),
      ).rejects.toThrow(/对象不存在/);
    });

    it("空对象 400", async () => {
      const storage = createStorageMock();
      storage.headObject.mockResolvedValueOnce({ size: 0 });
      await expect(
        verifyUploadedMedia(
          asStorage(storage),
          "course-video/44444444-4444-4444-4444-444444444444.mp4",
        ),
      ).rejects.toThrow(/对象为空/);
    });

    it("超过 2GB 时删掉对象并 400", async () => {
      const storage = createStorageMock();
      storage.headObject.mockResolvedValueOnce({ size: 3 * 1024 * 1024 * 1024 });
      const key = "course-video/55555555-5555-5555-5555-555555555555.mp4";

      await expect(verifyUploadedMedia(asStorage(storage), key)).rejects.toThrow(/上限/);
      expect(storage.deleteObject).toHaveBeenCalledWith(key);
    });
  });
});

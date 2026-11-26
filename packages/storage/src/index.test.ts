import { S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ObjectStorage, storageConfigFromEnv } from "./index";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("storageConfigFromEnv", () => {
  it("defaults to local MinIO (dev)", () => {
    expect(storageConfigFromEnv({})).toEqual({
      endpoint: "http://localhost:9000",
      region: "us-east-1",
      accessKeyId: "minioadmin",
      secretAccessKey: "minioadmin",
      bucket: "earthworm",
      forcePathStyle: true,
      presignExpiresSeconds: 21600,
      presignPutExpiresSeconds: 600,
    });
  });

  it("reads prod OSS overrides (virtual-host style)", () => {
    const config = storageConfigFromEnv({
      S3_ENDPOINT: "https://oss-cn-hangzhou.aliyuncs.com",
      S3_REGION: "oss-cn-hangzhou",
      S3_ACCESS_KEY_ID: "ak",
      S3_SECRET_ACCESS_KEY: "sk",
      S3_BUCKET: "my-bucket",
      S3_FORCE_PATH_STYLE: "false",
      S3_PRESIGN_EXPIRES_SECONDS: "3600",
      S3_PRESIGN_PUT_EXPIRES_SECONDS: "900",
    });
    expect(config).toEqual({
      endpoint: "https://oss-cn-hangzhou.aliyuncs.com",
      region: "oss-cn-hangzhou",
      accessKeyId: "ak",
      secretAccessKey: "sk",
      bucket: "my-bucket",
      forcePathStyle: false,
      presignExpiresSeconds: 3600,
      presignPutExpiresSeconds: 900,
    });
  });

  it("falls back to 6h for invalid expiry values", () => {
    for (const value of ["abc", "0", "-5", ""]) {
      expect(
        storageConfigFromEnv({ S3_PRESIGN_EXPIRES_SECONDS: value }).presignExpiresSeconds,
      ).toBe(21600);
    }
    expect(storageConfigFromEnv({ S3_PRESIGN_EXPIRES_SECONDS: "90.9" }).presignExpiresSeconds).toBe(
      90,
    );
  });

  it("falls back to 10min for invalid upload expiry values", () => {
    for (const value of ["abc", "0", "-5", ""]) {
      expect(
        storageConfigFromEnv({ S3_PRESIGN_PUT_EXPIRES_SECONDS: value }).presignPutExpiresSeconds,
      ).toBe(600);
    }
  });
});

describe("ObjectStorage.presignGet", () => {
  it("produces a path-style MinIO URL with signature and expiry", async () => {
    const storage = new ObjectStorage(storageConfigFromEnv({}));
    const url = await storage.presignGet("course-video/a.mp4");

    expect(url.startsWith("http://localhost:9000/earthworm/course-video/a.mp4?")).toBe(true);
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("X-Amz-Expires=21600");
  });

  it("produces a virtual-host OSS URL when forcePathStyle=false", async () => {
    const storage = new ObjectStorage(
      storageConfigFromEnv({
        S3_ENDPOINT: "https://oss-cn-hangzhou.aliyuncs.com",
        S3_REGION: "oss-cn-hangzhou",
        S3_FORCE_PATH_STYLE: "false",
        S3_BUCKET: "my-bucket",
      }),
    );
    const url = await storage.presignGet("tts/abc.mp3");

    expect(url.startsWith("https://my-bucket.oss-cn-hangzhou.aliyuncs.com/tts/abc.mp3?")).toBe(
      true,
    );
    expect(url).toContain("X-Amz-Signature=");
  });
});

describe("ObjectStorage not-found handling", () => {
  const storage = new ObjectStorage(storageConfigFromEnv({}));

  it("getBuffer returns null for NoSuchKey and rethrows other errors", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");

    send.mockRejectedValueOnce(
      new S3ServiceException({ name: "NoSuchKey", message: "missing", $metadata: {} }),
    );
    await expect(storage.getBuffer("tts/none.mp3")).resolves.toBeNull();

    send.mockRejectedValueOnce(new Error("network down"));
    await expect(storage.getBuffer("tts/none.mp3")).rejects.toThrow("network down");
  });

  it("getBuffer returns object bytes on hit", async () => {
    vi.spyOn(S3Client.prototype, "send").mockResolvedValueOnce({
      Body: { transformToByteArray: async () => Uint8Array.from([1, 2, 3]) },
    } as never);

    const buf = await storage.getBuffer("tts/hit.mp3");
    expect(buf).toEqual(Buffer.from([1, 2, 3]));
  });

  it("objectExists maps 404 to false and success to true", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");

    send.mockRejectedValueOnce(
      new S3ServiceException({
        name: "NotFound",
        message: "missing",
        $metadata: { httpStatusCode: 404 },
      }),
    );
    await expect(storage.objectExists("course-video/none.mp4")).resolves.toBe(false);

    send.mockResolvedValueOnce({} as never);
    await expect(storage.objectExists("course-video/yes.mp4")).resolves.toBe(true);
  });
});

describe("ObjectStorage.presignPut / headObject", () => {
  const storage = new ObjectStorage(storageConfigFromEnv({}));

  it("presigns a PUT url with the short upload expiry", async () => {
    const url = await storage.presignPut("course-video/a.mp4");

    expect(url.startsWith("http://localhost:9000/earthworm/course-video/a.mp4?")).toBe(true);
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("X-Amz-Expires=600");
  });

  it("does not sign Content-Type, so the browser may send any type", async () => {
    const url = await storage.presignPut("course-video/a.mp4");
    expect(decodeURIComponent(url)).not.toContain("content-type");
  });

  it("headObject returns size/contentType, and null for 404", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");

    send.mockResolvedValueOnce({
      ContentLength: 8388608,
      ContentType: "audio/mpeg",
    } as never);
    await expect(storage.headObject("course-video/a.mp3")).resolves.toEqual({
      size: 8388608,
      contentType: "audio/mpeg",
    });

    send.mockRejectedValueOnce(
      new S3ServiceException({
        name: "NotFound",
        message: "missing",
        $metadata: { httpStatusCode: 404 },
      }),
    );
    await expect(storage.headObject("course-video/none.mp3")).resolves.toBeNull();
  });
});

describe("ObjectStorage.listKeys / deleteByPrefix", () => {
  const storage = new ObjectStorage(storageConfigFromEnv({}));

  it("listKeys follows continuation tokens across pages", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");
    send
      .mockResolvedValueOnce({
        Contents: [{ Key: "forge/a/meta.json" }],
        IsTruncated: true,
        NextContinuationToken: "token-1",
      } as never)
      .mockResolvedValueOnce({
        Contents: [{ Key: "forge/a/course.json" }, {}],
        IsTruncated: false,
      } as never);

    await expect(storage.listKeys("forge/a/")).resolves.toEqual([
      "forge/a/meta.json",
      "forge/a/course.json",
    ]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].input).toMatchObject({
      Prefix: "forge/a/",
      ContinuationToken: "token-1",
    });
  });

  it("listKeys returns empty array for an empty prefix", async () => {
    vi.spyOn(S3Client.prototype, "send").mockResolvedValueOnce({} as never);
    await expect(storage.listKeys("forge/none/")).resolves.toEqual([]);
  });

  it("deleteByPrefix deletes every listed key", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");
    send
      .mockResolvedValueOnce({
        Contents: [{ Key: "forge/a/meta.json" }, { Key: "forge/a/course.json" }],
        IsTruncated: false,
      } as never)
      .mockResolvedValue({} as never);

    await storage.deleteByPrefix("forge/a/");

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[1][0].input).toMatchObject({ Key: "forge/a/meta.json" });
    expect(send.mock.calls[2][0].input).toMatchObject({ Key: "forge/a/course.json" });
  });
});

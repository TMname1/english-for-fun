import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface StorageConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** MinIO 需要 true（path-style）；阿里云 OSS 用 false（虚拟主机风格） */
  forcePathStyle: boolean;
  presignExpiresSeconds: number;
}

/**
 * 从环境变量解析存储配置。dev 默认值面向本地 MinIO；
 * prod 部署时按 README.devToProd.md 覆盖为阿里云 OSS 的 S3 兼容端点。
 */
export function storageConfigFromEnv(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const expires = Number(env.S3_PRESIGN_EXPIRES_SECONDS);
  return {
    endpoint: env.S3_ENDPOINT?.trim() || "http://localhost:9000",
    region: env.S3_REGION?.trim() || "us-east-1",
    accessKeyId: env.S3_ACCESS_KEY_ID?.trim() || "minioadmin",
    secretAccessKey: env.S3_SECRET_ACCESS_KEY?.trim() || "minioadmin",
    bucket: env.S3_BUCKET?.trim() || "earthworm",
    forcePathStyle: (env.S3_FORCE_PATH_STYLE?.trim() || "true") !== "false",
    presignExpiresSeconds:
      Number.isFinite(expires) && expires > 0 ? Math.floor(expires) : 6 * 60 * 60,
  };
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof S3ServiceException &&
    (error.name === "NoSuchKey" || error.$metadata.httpStatusCode === 404)
  );
}

export class ObjectStorage {
  readonly bucket: string;
  private readonly client: S3Client;
  private readonly presignExpiresSeconds: number;

  constructor(config: StorageConfig) {
    this.bucket = config.bucket;
    this.presignExpiresSeconds = config.presignExpiresSeconds;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async putBuffer(key: string, body: Buffer, contentType?: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /** 大文件（视频）分片上传，避免整文件读进内存 */
  async uploadFile(key: string, localPath: string, contentType?: string): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(localPath),
        ContentType: contentType,
      },
      queueSize: 4,
      partSize: 8 * 1024 * 1024,
    });
    await upload.done();
  }

  /** 对象不存在时返回 null */
  async getBuffer(key: string): Promise<Buffer | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!res.Body) return null;
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async downloadToFile(key: string, localPath: string): Promise<void> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    await mkdir(dirname(localPath), { recursive: true });
    await pipeline(res.Body as Readable, createWriteStream(localPath));
  }

  presignGet(key: string): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: this.presignExpiresSeconds,
    });
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** 列出前缀下全部对象键（自动翻页） */
  async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of res.Contents ?? []) {
        if (obj.Key) keys.push(obj.Key);
      }
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys;
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    const keys = await this.listKeys(prefix);
    for (const key of keys) {
      await this.deleteObject(key);
    }
  }

  async objectExists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }
}

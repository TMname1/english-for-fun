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

/** 预签名直传 URL 的有效期（秒）：浏览器拿到后要立刻 PUT，短一点更安全 */
const DEFAULT_PRESIGN_PUT_EXPIRES_SECONDS = 10 * 60;

/**
 * 连接超时 / 空闲超时。
 * AWS SDK v3 默认不设超时，链路半死时会一直挂着（线上表现为请求 100s 后被 Cloudflare 掐断、
 * 而应用日志里什么都没有）。这里给连接 5s、socket 空闲 120s 兜底：大文件只要还在流动就不会断，
 * 真的卡住了最多 2 分钟就抛错，比无限等好排查。
 */
const CONNECTION_TIMEOUT_MS = 5_000;
const SOCKET_IDLE_TIMEOUT_MS = 120_000;

export interface StorageConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** MinIO 需要 true（path-style）；阿里云 OSS 用 false（虚拟主机风格） */
  forcePathStyle: boolean;
  presignExpiresSeconds: number;
  /** 浏览器直传（预签名 PUT）的有效期秒数 */
  presignPutExpiresSeconds: number;
}

/**
 * 从环境变量解析存储配置。dev 默认值面向本地 MinIO；
 * prod 部署时按 README.env.prod.md 覆盖为阿里云 OSS 的 S3 兼容端点。
 */
export function storageConfigFromEnv(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const expires = Number(env.S3_PRESIGN_EXPIRES_SECONDS);
  const putExpires = Number(env.S3_PRESIGN_PUT_EXPIRES_SECONDS);
  return {
    endpoint: env.S3_ENDPOINT?.trim() || "http://localhost:9000",
    region: env.S3_REGION?.trim() || "us-east-1",
    accessKeyId: env.S3_ACCESS_KEY_ID?.trim() || "minioadmin",
    secretAccessKey: env.S3_SECRET_ACCESS_KEY?.trim() || "minioadmin",
    bucket: env.S3_BUCKET?.trim() || "earthworm",
    forcePathStyle: (env.S3_FORCE_PATH_STYLE?.trim() || "true") !== "false",
    presignExpiresSeconds:
      Number.isFinite(expires) && expires > 0 ? Math.floor(expires) : 6 * 60 * 60,
    presignPutExpiresSeconds:
      Number.isFinite(putExpires) && putExpires > 0
        ? Math.floor(putExpires)
        : DEFAULT_PRESIGN_PUT_EXPIRES_SECONDS,
  };
}

/** 对象元信息（HeadObject 子集） */
export interface StoredObjectMeta {
  size: number;
  contentType?: string;
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
  /** 预签名直传 URL 的有效期（秒），供上层回给前端展示/校验 */
  readonly presignPutExpiresSeconds: number;

  constructor(config: StorageConfig) {
    this.bucket = config.bucket;
    this.presignExpiresSeconds = config.presignExpiresSeconds;
    this.presignPutExpiresSeconds = config.presignPutExpiresSeconds;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      // 不设超时时，链路半死会一直挂着（见文件顶部 CONNECTION_TIMEOUT_MS 说明）
      maxAttempts: 3,
      requestHandler: {
        connectionTimeout: CONNECTION_TIMEOUT_MS,
        socketTimeout: SOCKET_IDLE_TIMEOUT_MS,
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

  /**
   * 浏览器直传用的预签名 PUT。
   * 故意**不签 Content-Type**：签名里带它的话，浏览器必须一字不差地回带同一个头，
   * 而 `File.type` 对某些扩展名可能是空串，很容易变成 403 SignatureDoesNotMatch。
   * 对象最终的 Content-Type 由浏览器 PUT 时带的头决定，`headObject()` 能读回来。
   */
  presignPut(key: string): Promise<string> {
    return getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: this.presignPutExpiresSeconds,
    });
  }

  /** 对象不存在时返回 null（用于确认直传是否真的完成） */
  async headObject(key: string): Promise<StoredObjectMeta | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        size: Number(res.ContentLength ?? 0),
        contentType: res.ContentType,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
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
    return (await this.headObject(key)) !== null;
  }
}

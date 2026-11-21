import { Injectable } from "@nestjs/common";

import { ObjectStorage, storageConfigFromEnv } from "@earthworm/storage";

/** ConfigModule.forRoot 已把 .env 加载进 process.env，这里直接按环境变量建 S3 客户端 */
@Injectable()
export class StorageService extends ObjectStorage {
  constructor() {
    super(storageConfigFromEnv());
  }

  /** 课程 video 字段：外部 http URL 原样透传，对象键转预签名 URL，空值返回 "" */
  async presignVideoUrl(value: string | null | undefined): Promise<string> {
    const v = value?.trim();
    if (!v) return "";
    if (/^https?:\/\//i.test(v)) return v;
    return this.presignGet(v);
  }
}

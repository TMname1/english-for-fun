import { randomUUID } from "node:crypto";
import { extname } from "node:path";

import { BadRequestException } from "@nestjs/common";
import { IsNotEmpty, IsString, MaxLength } from "class-validator";

import type { StorageService } from "../storage/storage.service";
import { isAllowedMediaExt, MAX_MEDIA_BYTES, MEDIA_EXT_LABELS } from "./media-ext";

/**
 * 音视频素材的对象键前缀。浏览器直传与历史 multipart 上传都往这里写，
 * 流水线/课程包只认这个前缀，避免预签名被拿来写任意键。
 */
export const MEDIA_KEY_PREFIX = "course-video/";

/** 申请直传 URL：只用来取扩展名，对象键由服务端生成 uuid */
export class PresignMediaUploadDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName: string;
}

/** 直传完成后回填的对象键（服务端会 HeadObject 校验） */
export class CompleteMediaUploadDto {
  @IsString()
  @IsNotEmpty()
  videoKey: string;
}

export interface MediaUploadTicket {
  key: string;
  uploadUrl: string;
  expiresInSeconds: number;
}

function extOfFileName(fileName: string): string {
  const ext = extname(fileName ?? "").toLowerCase();
  if (!isAllowedMediaExt(ext)) {
    throw new BadRequestException(
      `不支持的媒体格式：${ext || "(无扩展名)"}（支持 ${MEDIA_EXT_LABELS}）`,
    );
  }
  return ext;
}

/** 校验前端回传的对象键：必须落在素材前缀下、扩展名合法、不含路径穿越 */
export function assertMediaObjectKey(videoKey: string): string {
  const key = (videoKey ?? "").trim();
  if (!key.startsWith(MEDIA_KEY_PREFIX) || key.includes("..") || !isAllowedMediaExt(extname(key))) {
    throw new BadRequestException(`非法的 videoKey：${key || "(空)"}`);
  }
  return key;
}

/**
 * 下发预签名 PUT。
 * 直传是为了绕开 Cloudflare 的 100s 回源超时——线上实测经 Tunnel 的有效上行只有 ~47KB/s，
 * 8MB 素材根本传不完，必然 524。直传后大文件完全不经过服务器。
 */
export async function presignMediaUpload(
  storage: StorageService,
  fileName: string,
): Promise<MediaUploadTicket> {
  const key = `${MEDIA_KEY_PREFIX}${randomUUID()}${extOfFileName(fileName)}`;
  return {
    key,
    uploadUrl: await storage.presignPut(key),
    expiresInSeconds: storage.presignPutExpiresSeconds,
  };
}

/**
 * 确认对象真的落地了再继续（直传是浏览器干的，服务端必须自己核对）。
 * 返回已校验的对象键；对象不存在/为空/超限都会 400。
 */
export async function verifyUploadedMedia(
  storage: StorageService,
  videoKey: string,
): Promise<{ key: string; size: number }> {
  const key = assertMediaObjectKey(videoKey);
  const meta = await storage.headObject(key);
  if (!meta) {
    throw new BadRequestException("对象不存在：直传可能未完成，请重新上传");
  }
  if (meta.size <= 0) {
    throw new BadRequestException("对象为空：上传似乎没有成功，请重新上传");
  }
  if (meta.size > MAX_MEDIA_BYTES) {
    await storage.deleteObject(key).catch(() => {});
    throw new BadRequestException(`文件超过 ${MAX_MEDIA_BYTES / 1024 / 1024 / 1024}GB 上限`);
  }
  return { key, size: meta.size };
}

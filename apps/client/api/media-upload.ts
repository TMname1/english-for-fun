import type { $Fetch } from "ofetch";

import { useRuntimeConfig } from "#imports";
import { ofetch } from "ofetch";

/**
 * 音视频素材直传对象存储的公共链路（forge 切片与课程包配套视频共用）。
 *
 * 为什么不 POST 给 API：线上 API 在 Cloudflare Tunnel 后面，回源有效上行实测只有 ~47KB/s，
 * 且 CF 对回源有 100s 硬超时——8MB 素材必然 524。直传后大文件只走「浏览器 → OSS」，
 * 服务器完全不参与传输，也就没有 100s 的限制。
 */

/** 与 apps/api/src/common/media-ext.ts 的 MAX_MEDIA_BYTES 保持一致 */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

export interface MediaUploadTicket {
  /** 对象键，建任务/入库时回传 */
  key: string;
  /** 对象存储的预签名 PUT 地址（10 分钟有效） */
  uploadUrl: string;
  expiresInSeconds: number;
}

/** 直传相关的 HTTP 请求：加 timeout，避免 CF 524 那种 100s 干等 */
export function mediaFetch(): $Fetch {
  const config = useRuntimeConfig();
  return ofetch.create({
    baseURL: config.public.apiBase as string,
    credentials: "include",
    timeout: 20_000,
  });
}

/** 上传前先本地校验，省掉一次无效请求 */
export function assertUploadable(file: File): void {
  if (file.size <= 0) {
    throw new Error("文件是空的，请重新选择");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("文件超过 2GB 上限，请先压缩或切分");
  }
}

/** 申请直传票据：只传文件名（服务端据此定扩展名并生成 uuid key） */
export async function requestUploadTicket(
  presignPath: string,
  fileName: string,
): Promise<MediaUploadTicket> {
  return await mediaFetch()<MediaUploadTicket>(presignPath, {
    method: "post",
    body: { fileName },
    retry: 0,
  });
}

/** OSS 的失败响应是 XML，挑出 Code/Message 给用户看 */
function describeOssFailure(xhr: XMLHttpRequest): string {
  const body = xhr.responseText || "";
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
  const detail = code ? ` ${code}` : "";
  if (xhr.status === 0) {
    return "直传对象存储失败：请求被浏览器拦截（多半是 OSS 桶未配置 CORS 跨域规则），请检查桶的跨域设置";
  }
  if (xhr.status === 403) {
    return `直传对象存储被拒绝（403${detail}）：预签名已过期或 CORS 配置不对，请重试`;
  }
  if (xhr.status === 413) {
    return "直传对象存储失败：文件超过对象存储允许的单次上传大小";
  }
  return `直传对象存储失败（HTTP ${xhr.status}${detail}）`;
}

/**
 * 浏览器直接把文件 PUT 到 OSS。
 * 用 XHR 而不是 fetch：只有 XHR 能拿到上传进度。
 */
export function putFileToOss(
  ticket: MediaUploadTicket,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", ticket.uploadUrl, true);
    // Content-Type 不在签名里，跟着文件走即可；不设的话 OSS 会存成默认类型，播放器可能不解码
    if (file.type) xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress?.(Math.min(1, event.loaded / event.total));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        resolve();
        return;
      }
      reject(new Error(describeOssFailure(xhr)));
    };
    xhr.onerror = () => reject(new Error(describeOssFailure(xhr)));
    xhr.onabort = () => reject(new Error("上传已取消"));
    xhr.send(file);
  });
}

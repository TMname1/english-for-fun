/**
 * 媒体文件扩展名白名单与类型判定（音视频统一入口）。
 *
 * 上传入口（forge / course-pack）共用同一份集合，避免两处白名单各写一份后漂移。
 * 判定「音频 / 视频」只看扩展名：本系统里对象键由服务端生成（filename = uuid + 原扩展名），
 * 预签名只追加签名 query，pathname 的扩展名始终保留，因此扩展名是可靠依据。
 */

/** 视频容器（与历史白名单保持一致） */
export const VIDEO_EXT: ReadonlySet<string> = new Set([
  ".mp4",
  ".m4v",
  ".mkv",
  ".webm",
  ".mov",
  ".avi",
]);

/** 音频容器：只收浏览器全平台可解码的格式（ogg/flac 在 Safari 上不可靠，未纳入） */
export const AUDIO_EXT: ReadonlySet<string> = new Set([".mp3", ".m4a", ".wav", ".aac"]);

/** 上传白名单 = 视频 ∪ 音频 */
export const MEDIA_EXT: ReadonlySet<string> = new Set([...VIDEO_EXT, ...AUDIO_EXT]);

/** 白名单的展示文案（错误提示用） */
export const MEDIA_EXT_LABELS = "mp4/m4v/mkv/webm/mov/avi 与 mp3/m4a/wav/aac";

/** 单文件上限 2GB（浏览器直传与旧 multipart 上传共用同一口径） */
export const MAX_MEDIA_BYTES = 2 * 1024 * 1024 * 1024;

export type MediaKind = "video" | "audio";

/** 剥掉 query（预签名 URL）与 hash，再取小写扩展名 */
function extOf(value: string): string {
  const path = value.split(/[?#]/, 1)[0] ?? "";
  const match = /\.[^./\\]+$/.exec(path);
  return match ? match[0].toLowerCase() : "";
}

/**
 * 判定媒体类型：对象键（course-video/xxx.mp3）、预签名 URL、本地文件名都适用。
 * 未命中音频一律按 video 处理，兼容历史数据、无扩展名的外部链接与空值。
 */
export function mediaKindOf(value: string | null | undefined): MediaKind {
  const raw = value?.trim();
  if (!raw) return "video";
  return AUDIO_EXT.has(extOf(raw)) ? "audio" : "video";
}

/** 扩展名是否在上传白名单内（上传拦截用） */
export function isAllowedMediaExt(ext: string): boolean {
  return MEDIA_EXT.has(ext.toLowerCase());
}

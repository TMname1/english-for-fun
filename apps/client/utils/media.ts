/**
 * 媒体类型判定（前端侧）：课程包配套媒体既可能是视频也可能是音频，
 * 播放器据此决定渲染 <video> 画面还是 <audio> 播放条。
 *
 * 与 apps/api/src/common/media-ext.ts 的白名单保持一致。
 * 服务端读取接口会带 mediaKind，这里的判定用于两类场景：
 * 1) 接口未返回 mediaKind 时的兜底；2) 上传前对本地 File 的即时判断。
 */

/** 音频容器：只收浏览器全平台可解码的格式（ogg/flac 在 Safari 上不可靠） */
export const AUDIO_EXTENSIONS = [".mp3", ".m4a", ".wav", ".aac"] as const;

export type MediaKind = "video" | "audio";

/** 剥掉 query（预签名 URL）与 hash，再取小写扩展名 */
function extOf(value: string): string {
  const path = value.split(/[?#]/)[0] ?? "";
  const match = /\.[^./\\]+$/.exec(path);
  return match ? match[0].toLowerCase() : "";
}

/**
 * 是否为音频资源：支持对象键、预签名 URL、普通文件名。
 * 无扩展名（外部链接）或空值一律按视频处理，与服务端 mediaKindOf 一致。
 */
export function isAudioSource(value: string | null | undefined): boolean {
  const raw = value?.trim();
  if (!raw) return false;
  return (AUDIO_EXTENSIONS as readonly string[]).includes(extOf(raw));
}

/** 上传前的本地文件判定：优先看 MIME（部分系统给不出扩展名），再回退扩展名 */
export function mediaKindFromFile(file: File): MediaKind {
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("video/")) return "video";
  return isAudioSource(file.name) ? "audio" : "video";
}

/** 把任意来源（接口字段 / URL / 文件名）统一成媒体类型 */
export function resolveMediaKind(
  explicit: MediaKind | null | undefined,
  fallbackSource?: string | null,
): MediaKind {
  if (explicit === "audio" || explicit === "video") return explicit;
  return isAudioSource(fallbackSource) ? "audio" : "video";
}

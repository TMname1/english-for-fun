import type { PlayOptions } from "./audio";
import { isAudioSource } from "~/utils/media";

/**
 * 媒体区间播放：课程包带配套媒体（视频或音频）且 statement 有时间戳时，
 * 直接 seek 播放 [start, end] 区间代替音频/TTS。
 *
 * 元素为模块级单例（与 audio.ts 的 Audio 单例对称），由 VideoPlayer.vue
 * 通过 attachVideoContainer 挂到页面上；SSR/测试环境下延迟创建，模块加载不碰 document。
 *
 * 媒体类型（video / audio）由资源扩展名判定：视频渲染画面（默认隐藏控制栏，悬停显示），
 * 音频只渲染原生播放条（始终显示控制栏、不铺黑色背景）。
 */

/** seek 落点补偿：提前一点起播，避免爆破音起始被吃掉 */
const PRE_ROLL = 0.08;
/** 终点容差：宁可切早 20ms 也不拖到下一个词（timeupdate 只有 ~4Hz，须用 rAF 轮询） */
const END_TOLERANCE = 0.02;

let mediaEl: HTMLMediaElement | null = null;
/** 当前元素对应的媒体类型；与目标类型不一致时需要重建元素（见 ensureMediaElement） */
let currentKind: "video" | "audio" | null = null;
/** 容器由 VideoPlayer.vue 提供，重建元素后要挂回同一个父节点 */
let containerEl: HTMLElement | null = null;
let currentUrl = "";
let activeStop: (() => void) | null = null;

function createMediaElement(kind: "video" | "audio"): HTMLMediaElement {
  const el = document.createElement(kind);
  el.preload = "auto";
  if (kind === "video") {
    el.setAttribute("playsinline", "");
    // 控制栏默认隐藏，由 VideoPlayer.vue 鼠标悬停时切换显示
    el.controls = false;
    // 内联样式：class 写在 TS 里可能被 Tailwind 扫描遗漏
    el.style.width = "100%";
    el.style.maxHeight = "40vh";
    el.style.borderRadius = "0.5rem";
    el.style.backgroundColor = "#000";
  } else {
    // 音频没有画面，直接给原生播放条，不设黑色背景与高度
    el.controls = true;
    el.style.width = "100%";
  }
  return el;
}

/**
 * 取得指定类型的单例元素；类型变化（视频课程 ↔ 音频课程）时重建，
 * 避免残留 <video> 黑块或把音频塞进视频元素。
 */
function ensureMediaElement(kind: "video" | "audio"): HTMLMediaElement | null {
  if (mediaEl && currentKind === kind) return mediaEl;
  if (typeof document === "undefined") return null;

  mediaEl?.remove();
  mediaEl = createMediaElement(kind);
  currentKind = kind;
  if (currentUrl) {
    mediaEl.src = currentUrl;
  }
  if (containerEl) {
    containerEl.appendChild(mediaEl);
  }
  return mediaEl;
}

/** 当前资源的媒体类型（未设置资源时为 null） */
export function currentMediaKind(): "video" | "audio" | null {
  return currentKind;
}

/** 幂等设置媒体源；url 未变化时只确保元素就绪 */
export function setVideoSource(url: string): void {
  if (!url) return;
  const kind = isAudioSource(url) ? "audio" : "video";
  const urlChanged = url !== currentUrl;
  currentUrl = url;
  const el = ensureMediaElement(kind);
  if (el && urlChanged) {
    el.src = url;
    el.load();
  }
}

export function getVideoSource(): string {
  return currentUrl;
}

/** VideoPlayer.vue 挂载/卸载时调用：把单例元素移入容器或从 DOM 摘除 */
export function attachVideoContainer(container: HTMLElement | null): void {
  containerEl = container;
  if (!container) {
    mediaEl?.remove();
    return;
  }
  const kind = currentKind ?? (isAudioSource(currentUrl) ? "audio" : "video");
  const el = ensureMediaElement(kind);
  if (el && el.parentElement !== container) {
    container.appendChild(el);
  }
}

/** 显隐原生控制栏：VideoPlayer.vue 鼠标进入/离开容器时调用（音频始终显示） */
export function setVideoControls(visible: boolean): void {
  if (!mediaEl) return;
  mediaEl.controls = currentKind === "audio" ? true : visible;
}

/**
 * 播放 [start, end] 区间（秒），语义对齐 audio.ts 的 play()：
 * times 复读（间隔 interval ms）、rate 变速，返回 stop 函数。
 * 媒体源未就绪时返回 null，由调用方回退音频/TTS。
 */
export function playRange(
  start: number,
  end: number,
  playOptions?: PlayOptions,
): (() => void) | null {
  const el = ensureMediaElement(currentKind ?? (isAudioSource(currentUrl) ? "audio" : "video"));
  if (!el || !currentUrl) return null;

  const { times = 1, rate = 1, interval = 500 } = playOptions ?? {};

  activeStop?.();

  let rafId = 0;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let played = 1;
  let stopped = false;

  const onSeeked = (): void => {
    el.removeEventListener("seeked", onSeeked);
    if (stopped) return;
    el.play().catch((error) => {
      console.warn("[englishSound] media playback failed", error);
      stop();
    });
    rafId = requestAnimationFrame(tick);
  };

  function tick(): void {
    if (stopped) return;
    if (el!.currentTime >= end - END_TOLERANCE) {
      el!.pause();
      if (played < times) {
        timeoutId = setTimeout(() => {
          played++;
          playOnce();
        }, interval);
      }
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  function playOnce(): void {
    el!.playbackRate = rate;
    const target = Math.max(0, start - PRE_ROLL);
    el!.addEventListener("seeked", onSeeked);
    if (Math.abs(el!.currentTime - target) < 0.01) {
      // 设置相同位置不会触发 seeked，直接走播放
      onSeeked();
    } else {
      el!.currentTime = target;
    }
  }

  function stop(): void {
    stopped = true;
    cancelAnimationFrame(rafId);
    if (timeoutId) clearTimeout(timeoutId);
    el!.removeEventListener("seeked", onSeeked);
    el!.pause();
    if (activeStop === stop) {
      activeStop = null;
    }
  }

  playOnce();
  activeStop = stop;
  return stop;
}

/** 停止当前区间播放（切题/离开页面时调用） */
export function stopRange(): void {
  activeStop?.();
}

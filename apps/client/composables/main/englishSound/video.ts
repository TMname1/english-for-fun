import type { PlayOptions } from "./audio";

/**
 * 视频区间播放：课程包带配套视频且 statement 有时间戳时，
 * 直接 seek 视频播放 [start, end] 区间代替音频/TTS。
 *
 * 元素为模块级单例（与 audio.ts 的 Audio 单例对称），由 VideoPlayer.vue
 * 通过 attachVideoContainer 挂到页面上；SSR/测试环境下延迟创建，模块加载不碰 document。
 */

/** seek 落点补偿：提前一点起播，避免爆破音起始被吃掉 */
const PRE_ROLL = 0.08;
/** 终点容差：宁可切早 20ms 也不拖到下一个词（timeupdate 只有 ~4Hz，须用 rAF 轮询） */
const END_TOLERANCE = 0.02;

let videoEl: HTMLVideoElement | null = null;
let currentUrl = "";
let activeStop: (() => void) | null = null;

function ensureVideoElement(): HTMLVideoElement | null {
  if (videoEl) return videoEl;
  if (typeof document === "undefined") return null;
  videoEl = document.createElement("video");
  videoEl.setAttribute("playsinline", "");
  videoEl.preload = "auto";
  // 控制栏默认隐藏，由 VideoPlayer.vue 鼠标悬停时切换显示
  videoEl.controls = false;
  // 内联样式：class 写在 TS 里可能被 Tailwind 扫描遗漏
  videoEl.style.width = "100%";
  videoEl.style.maxHeight = "40vh";
  videoEl.style.borderRadius = "0.5rem";
  videoEl.style.backgroundColor = "#000";
  if (currentUrl) {
    videoEl.src = currentUrl;
  }
  return videoEl;
}

/** 幂等设置视频源；url 未变化时不做任何事 */
export function setVideoSource(url: string): void {
  if (!url || url === currentUrl) return;
  currentUrl = url;
  if (videoEl) {
    videoEl.src = url;
    videoEl.load();
  }
}

export function getVideoSource(): string {
  return currentUrl;
}

/** VideoPlayer.vue 挂载/卸载时调用：把单例元素移入容器或从 DOM 摘除 */
export function attachVideoContainer(container: HTMLElement | null): void {
  const el = ensureVideoElement();
  if (!el) return;
  if (container) {
    if (el.parentElement !== container) {
      container.appendChild(el);
    }
  } else {
    el.remove();
  }
}

/** 显隐原生控制栏：VideoPlayer.vue 鼠标进入/离开容器时调用 */
export function setVideoControls(visible: boolean): void {
  if (videoEl) {
    videoEl.controls = visible;
  }
}

/**
 * 播放 [start, end] 区间（秒），语义对齐 audio.ts 的 play()：
 * times 复读（间隔 interval ms）、rate 变速，返回 stop 函数。
 * 视频源未就绪时返回 null，由调用方回退音频/TTS。
 */
export function playRange(
  start: number,
  end: number,
  playOptions?: PlayOptions,
): (() => void) | null {
  const el = ensureVideoElement();
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
      console.warn("[englishSound] video playback failed", error);
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

import type { Ref } from "vue";

import { onScopeDispose, ref, watch } from "vue";

/** seek 落点补偿与终点容差，与 englishSound/video.ts 的 playRange 口径一致 */
const PRE_ROLL = 0.08;
const END_TOLERANCE = 0.02;

/**
 * 页面局部 <video> 的播放控制：播放头跟踪（rAF）、区间预览、播放/暂停。
 * 不复用 englishSound 单例——它绑定课程 store，混用会互相干扰。
 */
export function useClipPlayer(videoRef: Ref<HTMLVideoElement | null>) {
  const playhead = ref(0);
  const isPlaying = ref(false);
  const previewingIndex = ref<number | null>(null);

  let rafId = 0;
  let previewEnd: number | null = null;

  function track() {
    const el = videoRef.value;
    if (!el) return;
    playhead.value = el.currentTime;
    if (previewEnd !== null && el.currentTime >= previewEnd - END_TOLERANCE) {
      el.pause();
      previewEnd = null;
      previewingIndex.value = null;
      return;
    }
    rafId = requestAnimationFrame(track);
  }

  function startTracking() {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(track);
  }

  function stopPreview() {
    previewEnd = null;
    previewingIndex.value = null;
    videoRef.value?.pause();
  }

  function previewClip(index: number, start: number, end: number) {
    const el = videoRef.value;
    if (!el) return;
    if (previewingIndex.value === index) {
      stopPreview();
      return;
    }
    previewingIndex.value = index;
    previewEnd = end;
    el.currentTime = Math.max(0, start - PRE_ROLL);
    void el.play().catch(() => {
      previewEnd = null;
      previewingIndex.value = null;
    });
  }

  function seek(time: number) {
    const el = videoRef.value;
    if (!el) return;
    previewEnd = null;
    previewingIndex.value = null;
    el.currentTime = Math.max(0, Math.min(time, el.duration || time));
    playhead.value = el.currentTime;
  }

  function togglePlay() {
    const el = videoRef.value;
    if (!el) return;
    if (el.paused) {
      previewEnd = null;
      previewingIndex.value = null;
      void el.play().catch(() => {});
    } else {
      el.pause();
    }
  }

  function bind(el: HTMLVideoElement) {
    const onPlay = () => {
      isPlaying.value = true;
      startTracking();
    };
    const onPause = () => {
      isPlaying.value = false;
      cancelAnimationFrame(rafId);
      playhead.value = el.currentTime;
    };
    const onSeeked = () => {
      playhead.value = el.currentTime;
    };
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onPause);
    el.addEventListener("seeked", onSeeked);
    return () => {
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onPause);
      el.removeEventListener("seeked", onSeeked);
    };
  }

  let unbind: (() => void) | null = null;
  watch(
    videoRef,
    (el) => {
      unbind?.();
      unbind = el ? bind(el) : null;
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    cancelAnimationFrame(rafId);
    unbind?.();
  });

  return { playhead, isPlaying, previewingIndex, previewClip, stopPreview, seek, togglePlay };
}

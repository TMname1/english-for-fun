<template>
  <div
    v-if="hasInternalMedia"
    ref="container"
    class="mx-auto w-full max-w-3xl px-2 pt-2"
    @mouseenter="handleHover(true)"
    @mouseleave="handleHover(false)"
  ></div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { attachVideoContainer, setVideoControls } from "~/composables/main/englishSound/video";
import { useCourseStore } from "~/store/course";
import { resolveMediaKind } from "~/utils/media";

/**
 * 课程配套媒体播放器：
 * - 视频（对象存储预签名 URL，非外部链接）渲染 <video> 画面，控制栏仅在悬停时显示；
 * - 音频只渲染原生 <audio> 播放条，控制栏常显、不铺黑色背景。
 * 播放由 englishSound/video.ts 按 statement 时间戳驱动（seek 区间播放）；
 * 外部链接（bilibili 等旧数据）仍走 StudyVideoLink 外链。
 */
const courseStore = useCourseStore();
const container = ref<HTMLElement>();

const hasInternalMedia = computed(() => {
  const pack = courseStore.currentLearning;
  return Boolean(pack?.video) && !pack?.videoIsExternal;
});

const isAudioMedia = computed(() => {
  const pack = courseStore.currentLearning;
  return resolveMediaKind(pack?.mediaKind, pack?.video) === "audio";
});

function handleHover(visible: boolean) {
  // 音频用原生播放条，控制栏常显，不跟随悬停
  setVideoControls(isAudioMedia.value ? true : visible);
}

function attach() {
  attachVideoContainer(container.value ?? null);
  // 单例元素可能在别处悬停过，挂载时复位：视频隐藏控制栏，音频常显
  setVideoControls(isAudioMedia.value);
}

watch([hasInternalMedia, isAudioMedia], ([visible]) => {
  if (visible) {
    nextTick(attach);
  }
});

onMounted(() => {
  if (hasInternalMedia.value) {
    attach();
  }
});

onBeforeUnmount(() => {
  attachVideoContainer(null);
});
</script>

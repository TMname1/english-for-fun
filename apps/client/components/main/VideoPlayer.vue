<template>
  <div
    v-if="isInternalVideo"
    ref="container"
    class="mx-auto w-full max-w-3xl px-2 pt-2"
  ></div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { attachVideoContainer } from "~/composables/main/englishSound/video";
import { useCourseStore } from "~/store/course";

/**
 * 课程配套视频播放器：video 为站内路径（/course-video/...）时渲染，
 * 播放由 englishSound/video.ts 按 statement 时间戳驱动（seek 区间播放）；
 * 外部链接（bilibili 等旧数据）仍走 StudyVideoLink 外链。
 */
const courseStore = useCourseStore();
const container = ref<HTMLElement>();

const isInternalVideo = computed(() => (courseStore.currentLearning?.video ?? "").startsWith("/"));

function attach() {
  attachVideoContainer(container.value ?? null);
}

watch(isInternalVideo, (visible) => {
  if (visible) {
    nextTick(attach);
  }
});

onMounted(() => {
  if (isInternalVideo.value) {
    attach();
  }
});

onBeforeUnmount(() => {
  attachVideoContainer(null);
});
</script>

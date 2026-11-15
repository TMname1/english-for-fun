<template>
  <NuxtLink
    v-if="video && !isInternal"
    target="_blank"
    class="flex cursor-pointer items-center fill-current text-xl hover:text-fuchsia-500"
    :href="video"
  >
    <UTooltip text="边看边练">
      <UIcon
        name="i-simple-icons-bilibili"
        class="h-5 w-5"
      />
    </UTooltip>
  </NuxtLink>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  video?: string;
}>();

// 站内视频（/course-video/...）由页内 VideoPlayer 播放，不再渲染外链
const isInternal = computed(() => (props.video ?? "").startsWith("/"));
</script>

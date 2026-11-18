<template>
  <NuxtLink
    v-if="video && isExternal"
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
defineProps<{
  video?: string;
  /** 对象存储视频由页内 VideoPlayer 播放，只有外部链接才渲染外链图标 */
  isExternal?: boolean;
}>();
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <UButton
      icon="i-ph-scissors"
      :disabled="duration <= 0"
      @click="emit('add-cut')"
    >
      在 {{ formatTimecode(playhead) }} 添加切点
    </UButton>
    <UButton
      color="gray"
      variant="soft"
      size="md"
      @click="emit('select-all')"
    >
      全选
    </UButton>
    <UButton
      color="gray"
      variant="soft"
      @click="emit('select-none')"
    >
      全不选
    </UButton>

    <div class="ml-auto flex items-center gap-3">
      <span class="text-sm opacity-80">
        已选 <b class="text-violet-500">{{ selectedCount }}</b> / {{ totalCount }} 段 ·
        {{ formatDuration(selectedSeconds) }}
      </span>
      <UButton
        color="primary"
        size="md"
        icon="i-ph-microphone-stage"
        :loading="submitting"
        :disabled="selectedCount === 0"
        @click="emit('submit')"
      >
        转写选中片段
      </UButton>
    </div>
    <p
      v-if="selectedCount === 0"
      class="w-full text-right text-xs text-amber-500"
    >
      至少勾选一个片段才能开始转写
    </p>
  </div>
</template>

<script setup lang="ts">
import { formatDuration, formatTimecode } from "~/composables/videoClip/clipMath";

defineProps<{
  duration: number;
  playhead: number;
  selectedCount: number;
  totalCount: number;
  selectedSeconds: number;
  submitting: boolean;
}>();

const emit = defineEmits<{
  (e: "add-cut"): void;
  (e: "select-all"): void;
  (e: "select-none"): void;
  (e: "submit"): void;
}>();
</script>

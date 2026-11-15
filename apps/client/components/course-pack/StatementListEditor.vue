<template>
  <div class="flex flex-col gap-3">
    <div class="flex items-center justify-between">
      <span class="text-sm opacity-70">共 {{ list.length }} 条句子</span>
    </div>

    <p
      v-if="list.length === 0"
      class="rounded-lg border border-dashed p-4 text-center text-sm opacity-60 dark:border-gray-600"
    >
      暂无句子。点击下方「添加一句」或使用上方「导入句子 JSON」批量导入。
    </p>

    <div class="flex flex-col gap-3">
      <div
        v-for="(item, index) in list"
        :key="index"
        class="flex flex-col gap-2 rounded-lg border p-3 dark:border-gray-700"
      >
        <div class="flex items-center justify-between">
          <span class="text-xs font-medium opacity-70">#{{ index + 1 }}</span>
          <div class="flex items-center gap-1">
            <UButton
              icon="i-ph-arrow-up"
              color="gray"
              variant="ghost"
              size="xs"
              :disabled="index === 0"
              aria-label="上移"
              @click="move(index, -1)"
            />
            <UButton
              icon="i-ph-arrow-down"
              color="gray"
              variant="ghost"
              size="xs"
              :disabled="index === list.length - 1"
              aria-label="下移"
              @click="move(index, 1)"
            />
            <UButton
              icon="i-ph-trash"
              color="red"
              variant="ghost"
              size="xs"
              aria-label="删除"
              @click="removeAt(index)"
            />
          </div>
        </div>
        <UInput
          :model-value="item.english"
          placeholder="english（必填）"
          @update:model-value="(v: string | number) => patch(index, 'english', String(v ?? ''))"
        />
        <UInput
          :model-value="item.chinese"
          placeholder="chinese（必填）"
          @update:model-value="(v: string | number) => patch(index, 'chinese', String(v ?? ''))"
        />
        <UInput
          :model-value="item.phonetic"
          placeholder="phonetic（可选）"
          @update:model-value="(v: string | number) => patch(index, 'phonetic', String(v ?? ''))"
        />
        <div
          v-if="showTimings"
          class="grid grid-cols-2 gap-2"
        >
          <UInput
            type="number"
            step="0.01"
            :min="0"
            :model-value="item.startTime ?? ''"
            placeholder="开始时间(秒，可选)"
            @update:model-value="
              (v: string | number) => patchNumber(index, 'startTime', v as string | number)
            "
          />
          <UInput
            type="number"
            step="0.01"
            :min="0"
            :model-value="item.endTime ?? ''"
            placeholder="结束时间(秒，可选)"
            @update:model-value="
              (v: string | number) => patchNumber(index, 'endTime', v as string | number)
            "
          />
        </div>
      </div>
    </div>

    <UButton
      icon="i-ph-plus"
      color="primary"
      variant="soft"
      class="self-start"
      @click="append"
    >
      添加一句
    </UButton>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

import type { CreateCoursePackStatement } from "~/api/course-pack";

interface Props {
  modelValue: CreateCoursePackStatement[];
  /** 仅当课程包带配套视频时，展示每条句子的 startTime/endTime 输入框 */
  showTimings?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  showTimings: false,
});

const emit = defineEmits<{
  (e: "update:modelValue", value: CreateCoursePackStatement[]): void;
}>();

const list = computed(() => props.modelValue);

function commit(next: CreateCoursePackStatement[]) {
  emit("update:modelValue", next);
}

function append() {
  commit([...list.value, { english: "", chinese: "", phonetic: "" }]);
}

function removeAt(index: number) {
  commit(list.value.filter((_, i) => i !== index));
}

function move(index: number, delta: -1 | 1) {
  const target = index + delta;
  if (target < 0 || target >= list.value.length) return;
  const next = list.value.slice();
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item!);
  commit(next);
}

function patch(index: number, key: keyof CreateCoursePackStatement, value: string) {
  commit(list.value.map((s, i) => (i === index ? { ...s, [key]: value } : s)));
}

function patchNumber(index: number, key: "startTime" | "endTime", raw: string | number) {
  const text = String(raw ?? "").trim();
  const parsed = text === "" ? Number.NaN : Number(text);
  const value = Number.isFinite(parsed) ? parsed : undefined;
  commit(list.value.map((s, i) => (i === index ? { ...s, [key]: value } : s)));
}
</script>

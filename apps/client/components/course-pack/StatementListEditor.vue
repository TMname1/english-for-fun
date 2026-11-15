<template>
  <div class="flex flex-col gap-3">
    <div class="flex items-center justify-between">
      <span class="text-sm opacity-70">共 {{ list.length }} 条句子</span>
      <UButton
        :icon="showPasteArea ? 'i-ph-arrow-up' : 'i-ph-code'"
        color="gray"
        variant="ghost"
        size="xs"
        @click="showPasteArea = !showPasteArea"
      >
        {{ showPasteArea ? "收起 JSON" : "粘贴 JSON" }}
      </UButton>
    </div>

    <div
      v-if="showPasteArea"
      class="flex flex-col gap-2 rounded-lg border border-dashed p-3 dark:border-gray-600"
    >
      <p class="text-xs opacity-70">
        粘贴句子数组 JSON，「应用」后会替换当前列表。支持可选字段 startTime / endTime / words。
      </p>
      <UTextarea
        v-model="pasteText"
        :rows="5"
        class="font-mono text-sm"
        placeholder='[
  { "english": "How are you?", "chinese": "你好吗？", "phonetic": "/haʊ ɑːr ju/", "startTime": 0, "endTime": 1.2 }
]'
      />
      <div class="flex items-center gap-3">
        <UButton
          color="primary"
          variant="soft"
          size="xs"
          @click="applyPaste"
        >
          应用（替换列表）
        </UButton>
        <span
          v-if="pasteError"
          class="text-xs text-red-500"
        >
          {{ pasteError }}
        </span>
      </div>
    </div>

    <p
      v-if="list.length === 0"
      class="rounded-lg border border-dashed p-4 text-center text-sm opacity-60 dark:border-gray-600"
    >
      暂无句子。点击下方「添加一句」或使用右上角「粘贴 JSON」批量导入。
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
import { computed, ref } from "vue";

import type { CreateCoursePackStatement } from "~/api/course-pack";
import { parseStatementsJson } from "~/utils/coursePackManage";

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

const showPasteArea = ref(false);
const pasteText = ref("");
const pasteError = ref("");

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

function applyPaste() {
  pasteError.value = "";
  const result = parseStatementsJson(pasteText.value);
  if (!result.ok) {
    pasteError.value = result.error;
    return;
  }
  commit(result.statements);
  showPasteArea.value = false;
  pasteText.value = "";
}
</script>

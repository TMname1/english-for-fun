<template>
  <div class="space-y-4">
    <div v-if="videoSrc">
      <label class="mb-1 block text-sm font-medium">视频预览</label>
      <video
        :src="videoSrc"
        controls
        class="max-h-48 w-full rounded bg-black"
      />
    </div>

    <div>
      <div class="mb-2 flex items-center justify-between">
        <label class="text-sm font-medium">转录校对（{{ rows.length }} 段）</label>
        <span class="text-xs opacity-70">
          可修改每个单词的文字、删除整段；不能新增、不能改时间。改完点"继续处理"。
        </span>
      </div>

      <div
        class="max-h-[55vh] space-y-2 overflow-auto rounded border border-gray-200 p-2 dark:border-gray-700"
      >
        <div
          v-for="(row, idx) in rows"
          :key="row.id"
          class="rounded border border-gray-100 p-2 dark:border-gray-700"
        >
          <div class="mb-1 flex items-center justify-between text-xs opacity-70">
            <span> #{{ idx + 1 }} · {{ formatTime(row.start) }} – {{ formatTime(row.end) }} </span>
            <UButton
              size="xs"
              color="red"
              variant="ghost"
              :disabled="submitting"
              @click="removeRow(idx)"
            >
              删除整段
            </UButton>
          </div>
          <div class="flex flex-wrap gap-1.5">
            <input
              v-for="(w, wi) in row.words"
              :key="wi"
              v-model="w.word"
              type="text"
              class="rounded border px-1.5 py-0.5 text-sm dark:border-gray-600 dark:bg-gray-800"
              size="1"
              :style="{ width: `${Math.max(2, (w.word?.length ?? 1) + 1)}ch` }"
            />
          </div>
        </div>
        <p
          v-if="rows.length === 0"
          class="py-6 text-center text-sm opacity-70"
        >
          所有分段都已删除，无法继续。
        </p>
      </div>
    </div>

    <div class="flex justify-end gap-2 pt-2">
      <UButton
        color="gray"
        variant="ghost"
        :disabled="submitting"
        @click="emit('cancel')"
      >
        取消
      </UButton>
      <UButton
        :loading="submitting"
        :disabled="!canSubmit"
        @click="handleResume"
      >
        继续处理
      </UButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRuntimeConfig } from "#imports";
import { computed, onMounted, ref } from "vue";
import { toast } from "vue-sonner";

import type { ForgeJobView, ForgeTranscriptSegment, ResumeTranscriptSegment } from "~/api/forge";

const props = defineProps<{ job: ForgeJobView }>();
const emit = defineEmits<{
  (e: "resume", segments: ResumeTranscriptSegment[]): void;
  (e: "cancel"): void;
}>();

interface EditableWord {
  word: string;
  start: number;
  end: number;
}
interface EditableRow {
  id: number;
  start: number;
  end: number;
  words: EditableWord[];
}

const submitting = ref(false);
const rows = ref<EditableRow[]>([]);

// videoPath 是对象存储预签名 URL（绝对地址），直接播放
const videoSrc = computed(() => props.job.videoPath || "");

const canSubmit = computed(
  () =>
    rows.value.length > 0 &&
    rows.value.every((row) => row.words.some((w) => (w.word ?? "").trim().length > 0)),
);

onMounted(() => {
  const segments = props.job.transcriptJson?.segments ?? [];
  rows.value = segments.map(toEditable);
});

/**
 * 把转录分段映射为可编辑行。段级降级（无词时间戳）时合成单个跨越整段的词，
 * 仍可编辑文字且时间不变（词数保持 1，与 normalizeEditedTranscript 口径一致）。
 */
function toEditable(seg: ForgeTranscriptSegment): EditableRow {
  const words = (seg.words ?? []).map((w) => ({ word: w.word, start: w.start, end: w.end }));
  if (words.length === 0) {
    words.push({ word: (seg.text ?? "").trim(), start: seg.start, end: seg.end });
  }
  return { id: seg.id, start: seg.start, end: seg.end, words };
}

function removeRow(idx: number) {
  rows.value.splice(idx, 1);
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0.0s";
  return `${seconds.toFixed(1)}s`;
}

function handleResume() {
  if (!canSubmit.value) {
    toast.error("请至少保留一段，且每段都要有内容");
    return;
  }
  const segments: ResumeTranscriptSegment[] = rows.value.map((row) => {
    const words = row.words
      .map((w) => ({ word: (w.word ?? "").trim(), start: w.start, end: w.end }))
      .filter((w) => w.word.length > 0);
    return {
      id: row.id,
      start: row.start,
      end: row.end,
      text: words.map((w) => w.word).join(" "),
      words,
    };
  });
  submitting.value = true;
  emit("resume", segments);
}
</script>

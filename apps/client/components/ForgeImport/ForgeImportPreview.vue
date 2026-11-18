<template>
  <div class="space-y-4">
    <div>
      <label class="mb-1 block text-sm font-medium">课程包标题</label>
      <UInput
        v-model="localTitle"
        class="w-full"
      />
    </div>

    <div>
      <label class="mb-1 block text-sm font-medium">描述</label>
      <UTextarea
        v-model="localDescription"
        :rows="2"
        class="w-full"
      />
    </div>

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
        <label class="text-sm font-medium">句子（{{ statements.length }} 条）</label>
        <span class="text-xs opacity-70">
          修改后点"导入到课程库"才会写库；words 列折叠展示，只读
        </span>
      </div>
      <div class="max-h-[50vh] overflow-auto rounded border border-gray-200 dark:border-gray-700">
        <table class="w-full text-sm">
          <thead class="sticky top-0 bg-gray-50 text-left dark:bg-gray-800">
            <tr>
              <th class="px-2 py-1.5 font-medium">#</th>
              <th class="px-2 py-1.5 font-medium">english</th>
              <th class="px-2 py-1.5 font-medium">chinese</th>
              <th class="px-2 py-1.5 font-medium">phonetic</th>
              <th class="px-2 py-1.5 font-medium">start(s)</th>
              <th class="px-2 py-1.5 font-medium">end(s)</th>
              <th class="px-2 py-1.5 font-medium">words</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(stmt, idx) in statements"
              :key="idx"
              class="border-t border-gray-100 align-top dark:border-gray-700"
            >
              <td class="px-2 py-1.5 opacity-70">{{ idx + 1 }}</td>
              <td class="px-2 py-1.5">
                <textarea
                  v-model="stmt.english"
                  rows="2"
                  class="w-full rounded border px-1.5 py-1 text-xs dark:border-gray-600 dark:bg-gray-800"
                />
              </td>
              <td class="px-2 py-1.5">
                <textarea
                  v-model="stmt.chinese"
                  rows="2"
                  class="w-full rounded border px-1.5 py-1 text-xs dark:border-gray-600 dark:bg-gray-800"
                />
              </td>
              <td class="px-2 py-1.5">
                <input
                  v-model="stmt.phonetic"
                  class="w-full rounded border px-1.5 py-1 text-xs dark:border-gray-600 dark:bg-gray-800"
                />
              </td>
              <td class="px-2 py-1.5">
                <input
                  v-model.number="stmt.startTime"
                  type="number"
                  step="0.01"
                  class="w-20 rounded border px-1.5 py-1 text-xs dark:border-gray-600 dark:bg-gray-800"
                />
              </td>
              <td class="px-2 py-1.5">
                <input
                  v-model.number="stmt.endTime"
                  type="number"
                  step="0.01"
                  class="w-20 rounded border px-1.5 py-1 text-xs dark:border-gray-600 dark:bg-gray-800"
                />
              </td>
              <td class="px-2 py-1.5">
                <details>
                  <summary class="cursor-pointer text-xs opacity-70">
                    {{ stmt.words?.length ?? 0 }} 词
                  </summary>
                  <div class="mt-1 max-w-xs text-xs opacity-80">
                    <span
                      v-for="(w, wi) in stmt.words ?? []"
                      :key="wi"
                      class="mr-1 inline-block"
                    >
                      {{ w.word }}<sub>{{ w.start.toFixed(2) }}</sub>
                    </span>
                  </div>
                </details>
              </td>
            </tr>
          </tbody>
        </table>
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
        :disabled="statements.length === 0"
        @click="handleConfirm"
      >
        导入到课程库
      </UButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRuntimeConfig } from "#imports";
import { computed, onMounted, ref } from "vue";
import { toast } from "vue-sonner";

import type { CreateCoursePackPayload } from "~/api/course-pack";
import type { ForgeJobCourseStatement, ForgeJobView } from "~/api/forge";
import { createCoursePack } from "~/api/course-pack";

const props = defineProps<{ job: ForgeJobView }>();
const emit = defineEmits<{
  (e: "confirmed", coursePackId: string): void;
  (e: "cancel"): void;
}>();

interface EditableStatement {
  english: string;
  chinese: string;
  phonetic: string;
  startTime: number | null;
  endTime: number | null;
  words?: { word: string; start: number; end: number }[];
}

const submitting = ref(false);
const localTitle = ref("");
const localDescription = ref("");
const statements = ref<EditableStatement[]>([]);

const courseJson = computed(() => props.job.courseJson);
// videoPath 是对象存储预签名 URL（绝对地址），直接播放
const videoSrc = computed(() => props.job.videoPath || "");

onMounted(() => {
  const data = courseJson.value;
  if (!data) {
    toast.error("course.json 缺失，无法预览");
    return;
  }
  localTitle.value = data.title ?? props.job.title ?? "";
  localDescription.value = data.description ?? props.job.description ?? "";
  statements.value = (data.courses?.statements ?? []).map(toEditable);
});

function toEditable(s: ForgeJobCourseStatement): EditableStatement {
  return {
    english: s.english ?? "",
    chinese: s.chinese ?? "",
    phonetic: s.phonetic ?? "",
    startTime: s.startTime ?? null,
    endTime: s.endTime ?? null,
    words: s.words ?? undefined,
  };
}

async function handleConfirm() {
  const payload = buildPayload();
  if (!payload) return;
  submitting.value = true;
  try {
    const result = await createCoursePack(payload);
    toast.success("已导入到课程库");
    emit("confirmed", result.coursePackId);
  } catch (error) {
    toast.error("导入失败：" + (error instanceof Error ? error.message : String(error)));
  } finally {
    submitting.value = false;
  }
}

function buildPayload(): CreateCoursePackPayload | null {
  if (!localTitle.value.trim()) {
    toast.error("请填写课程包标题");
    return null;
  }
  if (statements.value.length === 0) {
    toast.error("句子列表为空，无法导入");
    return null;
  }
  const data = courseJson.value;
  return {
    title: localTitle.value.trim(),
    description: localDescription.value.trim(),
    cover: data?.cover ?? "",
    video: props.job.videoKey || undefined,
    courses: {
      title: data?.courses?.title ?? localTitle.value.trim(),
      description: data?.courses?.description ?? "",
      statements: statements.value.map((s) => ({
        english: s.english.trim(),
        chinese: s.chinese.trim(),
        phonetic: s.phonetic.trim(),
        startTime: numberOrUndefined(s.startTime),
        endTime: numberOrUndefined(s.endTime),
        words: s.words && s.words.length > 0 ? s.words : undefined,
      })),
    },
  };
}

function numberOrUndefined(value: number | null | undefined): number | undefined {
  if (value == null) return undefined;
  if (Number.isNaN(value)) return undefined;
  return value;
}
</script>

<template>
  <UModal
    :model-value="show"
    :ui="{ width: 'w-full sm:max-w-3xl' }"
    @update:model-value="handleVisibilityChange"
  >
    <div class="p-6 text-gray-900 dark:text-white">
      <h2 class="mb-4 text-xl font-bold">导入视频</h2>

      <form
        v-if="step === 'form'"
        class="space-y-4"
        @submit.prevent="handleSubmit"
      >
        <div>
          <label class="mb-1 block text-sm font-medium">视频文件</label>
          <input
            ref="fileInput"
            type="file"
            class="hidden"
            :accept="VIDEO_ACCEPT"
            @change="handleFileChange"
          />
          <div class="flex items-center gap-3">
            <UButton
              type="button"
              color="gray"
              variant="outline"
              @click="fileInput?.click()"
            >
              选择文件
            </UButton>
            <span class="truncate text-sm opacity-80">
              {{ file ? `${file.name}（${formatSize(file.size)}）` : "尚未选择" }}
            </span>
          </div>
          <p class="mt-1 text-xs opacity-70">
            支持 mp4 / m4v / mkv / webm / mov / avi，单文件最大 2GB
          </p>
        </div>

        <div>
          <label class="mb-1 block text-sm font-medium">
            课程包标题 <span class="text-red-500">*</span>
          </label>
          <UInput
            v-model="form.title"
            placeholder="例如：Friends S01E01"
            class="w-full"
          />
        </div>

        <div>
          <label class="mb-1 block text-sm font-medium">类型</label>
          <div class="flex gap-4 text-sm">
            <label class="flex items-center gap-1.5">
              <input
                v-model="form.type"
                type="radio"
                value="dialogue"
              />
              <span>对话 dialogue</span>
            </label>
            <label class="flex items-center gap-1.5">
              <input
                v-model="form.type"
                type="radio"
                value="music"
              />
              <span>音乐 music</span>
            </label>
          </div>
        </div>

        <div>
          <label class="mb-1 block text-sm font-medium">ASR 语言</label>
          <select
            v-model="form.language"
            class="select select-bordered w-full max-w-xs"
          >
            <option value="en">英语 en</option>
            <option value="zh">中文 zh</option>
            <option value="ja">日语 ja</option>
          </select>
        </div>

        <div>
          <label class="mb-1 block text-sm font-medium">描述（可选）</label>
          <UTextarea
            v-model="form.desc"
            :rows="3"
            placeholder="留空则由流水线生成默认描述"
          />
        </div>

        <div class="flex justify-end gap-2 pt-2">
          <UButton
            type="button"
            color="gray"
            variant="ghost"
            @click="close"
            >取消</UButton
          >
          <UButton
            type="submit"
            :disabled="!canSubmit"
            >开始处理</UButton
          >
        </div>
      </form>

      <div
        v-else-if="step === 'working'"
        class="space-y-4 py-4"
      >
        <div class="flex items-center gap-3">
          <UIcon
            name="i-ph-circle-notch"
            class="h-6 w-6 animate-spin"
          />
          <span class="text-base">{{ workingLabel }}</span>
          <span class="ml-auto text-sm opacity-70">已用 {{ elapsed }}s</span>
        </div>
        <p class="text-xs opacity-70">
          先提取音轨并 ASR 转写，转录完成后会暂停让你校对文字；之后自动继续 LLM
          结构化与时间戳对齐。请勿关闭页面。
        </p>
        <div class="flex justify-end">
          <UButton
            color="red"
            variant="soft"
            @click="cancelWorking"
            >取消</UButton
          >
        </div>
      </div>

      <ForgeTranscriptReview
        v-else-if="step === 'review' && job"
        :job="job"
        @resume="handleResume"
        @cancel="close"
      />

      <div
        v-else-if="step === 'failed'"
        class="space-y-4 py-4"
      >
        <div class="flex items-center gap-3 text-red-500">
          <UIcon
            name="i-ph-x-circle"
            class="h-6 w-6"
          />
          <span class="text-base">流水线失败</span>
        </div>
        <pre
          class="overflow-auto whitespace-pre-wrap rounded bg-gray-100 p-3 text-xs dark:bg-gray-800"
          >{{ job?.error ?? "未知错误" }}</pre
        >
        <div class="flex justify-end gap-2">
          <UButton
            color="gray"
            variant="ghost"
            @click="close"
            >关闭</UButton
          >
          <UButton @click="retry">重试</UButton>
        </div>
      </div>
    </div>
  </UModal>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { toast } from "vue-sonner";

import type { ForgeJobView, ResumeTranscriptSegment } from "~/api/forge";
import { createCoursePack } from "~/api/course-pack";
import { cancelForgeJob, resumeForgeJob, uploadForgeJob } from "~/api/forge";
import { buildCoursePackPayload } from "~/composables/forge/buildCoursePackPayload";
import { useForgeJob } from "~/composables/forge/useForgeJob";
import ForgeTranscriptReview from "./ForgeTranscriptReview.vue";

type Step = "form" | "working" | "review" | "failed";

const props = defineProps<{ show: boolean }>();
const emit = defineEmits<{
  (e: "update:show", value: boolean): void;
  (e: "confirmed", coursePackId: string): void;
}>();

const VIDEO_ACCEPT = ".mp4,.m4v,.mkv,.webm,.mov,.avi";

const step = ref<Step>("form");
const importing = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const file = ref<File | null>(null);
const form = reactive({
  title: "",
  type: "dialogue" as "dialogue" | "music",
  desc: "",
  language: "en",
});

const forge = useForgeJob();
const job = computed<ForgeJobView | null>(() => forge.job.value);
const elapsed = forge.elapsedSeconds;
const workingLabel = computed(() => {
  if (!forge.job.value) return "上传中…";
  return forge.stageLabel.value || "处理中…";
});

const canSubmit = computed(() => Boolean(file.value && form.title.trim()));

watch(
  () => forge.isAwaitingReview.value,
  (awaiting) => {
    if (awaiting && step.value === "working") step.value = "review";
  },
);
watch(
  () => forge.isDone.value,
  (done) => {
    if (done && step.value === "working") void finalizeImport();
  },
);
watch(
  () => forge.isFailed.value || forge.isCancelled.value,
  (bad) => {
    if (bad && (step.value === "working" || step.value === "review")) step.value = "failed";
  },
);

function handleFileChange(event: Event) {
  const target = event.target as HTMLInputElement;
  file.value = target.files?.[0] ?? null;
}

async function handleSubmit() {
  if (!file.value || !form.title.trim()) {
    toast.error("请先选择视频文件并填写标题");
    return;
  }
  step.value = "working";
  try {
    const { jobId } = await uploadForgeJob({
      file: file.value,
      title: form.title.trim(),
      type: form.type,
      desc: form.desc.trim() || undefined,
      language: form.language,
    });
    forge.start(jobId);
  } catch (error) {
    step.value = "failed";
    toast.error("上传失败：" + (error instanceof Error ? error.message : String(error)));
  }
}

function handleVisibilityChange(value: boolean) {
  if (!value) close();
  emit("update:show", value);
}

function close() {
  if (
    (step.value === "working" || step.value === "review") &&
    job.value &&
    !forge.isTerminal.value
  ) {
    void cancelForgeJob(job.value.id);
  }
  resetAll();
  emit("update:show", false);
}

function cancelWorking() {
  if (job.value && !forge.isTerminal.value) {
    void cancelForgeJob(job.value.id);
  }
  resetAll();
}

function retry() {
  step.value = "form";
  forge.reset();
}

function resetAll() {
  forge.reset();
  step.value = "form";
  file.value = null;
  if (fileInput.value) fileInput.value.value = "";
  form.title = "";
  form.type = "dialogue";
  form.desc = "";
  form.language = "en";
}

function handleResume(segments: ResumeTranscriptSegment[]) {
  if (!job.value) return;
  step.value = "working";
  void (async () => {
    try {
      await resumeForgeJob(job.value!.id, segments);
      forge.start(job.value!.id);
    } catch (error) {
      step.value = "failed";
      toast.error("继续处理失败：" + (error instanceof Error ? error.message : String(error)));
    }
  })();
}

/** 流水线 done：去掉末尾可编辑预览，直接按产物写库并跳转 */
async function finalizeImport() {
  const j = job.value;
  if (!j?.courseJson) {
    step.value = "failed";
    toast.error("产物缺失，无法导入");
    return;
  }
  if (importing.value) return;
  importing.value = true;
  try {
    const payload = buildCoursePackPayload(j);
    const result = await createCoursePack(payload);
    toast.success("已导入到课程库");
    handleConfirmed(result.coursePackId);
  } catch (error) {
    step.value = "failed";
    toast.error("导入失败：" + (error instanceof Error ? error.message : String(error)));
  } finally {
    importing.value = false;
  }
}

function handleConfirmed(coursePackId: string) {
  emit("confirmed", coursePackId);
  resetAll();
  emit("update:show", false);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
</script>

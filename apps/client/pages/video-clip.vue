<template>
  <div class="mx-auto my-8 w-full max-w-screen-lg space-y-5 px-4 md:px-8">
    <div>
      <h2
        class="bg-gradient-to-r from-violet-500 via-fuchsia-500 to-cyan-400 bg-clip-text text-2xl font-bold text-transparent"
      >
        视频切片转写
      </h2>
      <p class="mt-1 text-sm opacity-70">
        上传视频 → 时间轴打切点 → 勾选片段 → 只转写选中的部分 → 校对 → 生成课程
      </p>
    </div>

    <div
      class="rounded-lg bg-white px-6 py-6 shadow-even-lg dark:bg-gray-900 dark:shadow-gray-700 md:px-10"
    >
      <ClipUploadForm
        v-if="step === 'upload'"
        :uploading="uploading"
        @submit="handleUpload"
      />

      <div
        v-else-if="step === 'edit'"
        class="space-y-4"
      >
        <video
          ref="videoEl"
          :src="videoUrl"
          controls
          playsinline
          preload="auto"
          class="max-h-[45vh] w-full rounded-lg bg-black"
          @loadedmetadata="handleMetadata"
        />

        <ClipToolbar
          :duration="editor.duration.value"
          :playhead="player.playhead.value"
          :selected-count="editor.selectedClips.value.length"
          :total-count="editor.clips.value.length"
          :selected-seconds="editor.selectedSeconds.value"
          :submitting="submitting"
          @add-cut="handleAddCut"
          @select-all="editor.selectAll(true)"
          @select-none="editor.selectAll(false)"
          @submit="handleSubmitClips"
        />

        <ClipTimeline
          :duration="editor.duration.value"
          :cuts="editor.cuts.value"
          :clips="editor.clips.value"
          :playhead="player.playhead.value"
          :previewing-index="player.previewingIndex.value"
          :is-playing="player.isPlaying.value"
          @seek="player.seek"
          @remove-cut="handleRemoveCut"
          @toggle-clip="editor.toggleClip"
          @preview="handlePreview"
        />

        <p class="text-xs opacity-60">
          快捷键：空格 播放/暂停 · C 在播放头添加切点。不打切点则整段视频作为一个片段转写。
        </p>
      </div>

      <div
        v-else-if="step === 'working'"
        class="space-y-4 py-4"
      >
        <div class="flex items-center gap-3">
          <UIcon
            name="i-ph-circle-notch"
            class="h-6 w-6 animate-spin text-violet-500"
          />
          <span class="text-base">{{ workingLabel }}</span>
          <span class="ml-auto text-sm opacity-70">已用 {{ forge.elapsedSeconds.value }}s</span>
        </div>
        <p class="text-xs opacity-70">
          只转写勾选的 {{ submittedClipCount }} 个片段（首次启动本地 ASR 容器可能需数分钟）。
          转录完成后会暂停让你校对文字，之后自动继续 LLM 结构化与时间戳对齐。请勿关闭页面。
        </p>
        <div class="flex justify-end">
          <UButton
            color="red"
            variant="soft"
            @click="handleCancel"
          >
            取消
          </UButton>
        </div>
      </div>

      <div
        v-else-if="step === 'review' && forge.job.value"
        class="space-y-3"
      >
        <h3 class="text-lg font-semibold">校对转写结果</h3>
        <ForgeTranscriptReview
          :job="forge.job.value"
          @resume="handleResume"
          @cancel="handleCancel"
        />
      </div>

      <div
        v-else-if="step === 'failed'"
        class="space-y-4 py-4"
      >
        <div class="flex items-center gap-3 text-red-500">
          <UIcon
            name="i-ph-x-circle"
            class="h-6 w-6"
          />
          <span class="text-base">处理失败</span>
        </div>
        <pre
          class="overflow-auto whitespace-pre-wrap rounded bg-gray-100 p-3 text-xs dark:bg-gray-800"
          >{{ errorText }}</pre
        >
        <div class="flex justify-end">
          <UButton @click="resetAll">重新开始</UButton>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { navigateTo, useRuntimeConfig } from "#imports";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { toast } from "vue-sonner";

import type { ResumeTranscriptSegment } from "~/api/forge";
import type { ClipUploadPayload } from "~/components/VideoClip/ClipUploadForm.vue";
import { createCoursePack } from "~/api/course-pack";
import {
  cancelForgeJob,
  fetchForgeJob,
  resumeForgeJob,
  startForgeJob,
  uploadForgeJob,
} from "~/api/forge";
import ForgeTranscriptReview from "~/components/ForgeImport/ForgeTranscriptReview.vue";
import ClipTimeline from "~/components/VideoClip/ClipTimeline.vue";
import ClipToolbar from "~/components/VideoClip/ClipToolbar.vue";
import ClipUploadForm from "~/components/VideoClip/ClipUploadForm.vue";
import { buildCoursePackPayload } from "~/composables/forge/buildCoursePackPayload";
import { useForgeJob } from "~/composables/forge/useForgeJob";
import { useClipEditor } from "~/composables/videoClip/useClipEditor";
import { useClipPlayer } from "~/composables/videoClip/useClipPlayer";

type Step = "upload" | "edit" | "working" | "review" | "failed";

const runtimeConfig = useRuntimeConfig();
const step = ref<Step>("upload");
const uploading = ref(false);
const submitting = ref(false);
const importing = ref(false);
const jobId = ref<string | null>(null);
const videoUrl = ref("");
const videoEl = ref<HTMLVideoElement | null>(null);
const errorText = ref("");
const submittedClipCount = ref(1);

const editor = useClipEditor();
const player = useClipPlayer(videoEl);
const forge = useForgeJob();

const workingLabel = computed(() => forge.stageLabel.value || "处理中…");

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
    if (bad && (step.value === "working" || step.value === "review")) {
      errorText.value = forge.errorText.value || "任务已取消";
      step.value = "failed";
    }
  },
);

async function handleUpload(payload: ClipUploadPayload) {
  uploading.value = true;
  try {
    const { jobId: id } = await uploadForgeJob({ ...payload, defer: true });
    jobId.value = id;
    const view = await fetchForgeJob(id);
    videoUrl.value = `${runtimeConfig.public.apiBase}${view.videoPath}`;
    editor.reset();
    step.value = "edit";
  } catch (error) {
    toast.error("上传失败：" + (error instanceof Error ? error.message : String(error)));
  } finally {
    uploading.value = false;
  }
}

function handleMetadata() {
  if (videoEl.value) {
    editor.duration.value = videoEl.value.duration;
  }
}

function handleAddCut() {
  player.stopPreview();
  if (!editor.addCutAt(player.playhead.value)) {
    toast.info("切点太靠近端点或已有切点，已忽略");
  }
}

function handleRemoveCut(cut: number) {
  player.stopPreview();
  editor.removeCut(cut);
}

function handlePreview(index: number) {
  const clip = editor.clips.value[index];
  if (clip) player.previewClip(index, clip.start, clip.end);
}

async function handleSubmitClips() {
  if (!jobId.value || editor.selectedClips.value.length === 0) return;
  player.stopPreview();
  submitting.value = true;
  try {
    // 无切点 = 整段转写，走后端原路径
    const clips = editor.cuts.value.length > 0 ? editor.selectedClips.value : undefined;
    submittedClipCount.value = editor.selectedClips.value.length;
    await startForgeJob(jobId.value, clips);
    forge.start(jobId.value);
    step.value = "working";
  } catch (error) {
    toast.error("启动转写失败：" + (error instanceof Error ? error.message : String(error)));
  } finally {
    submitting.value = false;
  }
}

function handleResume(segments: ResumeTranscriptSegment[]) {
  if (!jobId.value) return;
  step.value = "working";
  void (async () => {
    try {
      await resumeForgeJob(jobId.value!, segments);
      forge.start(jobId.value!);
    } catch (error) {
      errorText.value = error instanceof Error ? error.message : String(error);
      step.value = "failed";
    }
  })();
}

function handleCancel() {
  if (jobId.value && !forge.isTerminal.value) {
    void cancelForgeJob(jobId.value).catch(() => {});
  }
  resetAll();
}

async function finalizeImport() {
  const j = forge.job.value;
  if (!j || importing.value) return;
  importing.value = true;
  try {
    const payload = buildCoursePackPayload(j);
    const result = await createCoursePack(payload);
    toast.success("已导入到课程库");
    navigateTo(`/game/${result.coursePackId}`);
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : String(error);
    step.value = "failed";
  } finally {
    importing.value = false;
  }
}

function resetAll() {
  forge.reset();
  editor.reset();
  player.stopPreview();
  jobId.value = null;
  videoUrl.value = "";
  errorText.value = "";
  step.value = "upload";
}

function handleKeydown(event: KeyboardEvent) {
  if (step.value !== "edit") return;
  const tag = (event.target as HTMLElement)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (event.code === "Space") {
    event.preventDefault();
    player.togglePlay();
  } else if (event.code === "KeyC") {
    handleAddCut();
  }
}

function handleBeforeUnload(event: BeforeUnloadEvent) {
  if (step.value === "working" || step.value === "review") {
    event.preventDefault();
    event.returnValue = "";
  }
}

onMounted(() => {
  window.addEventListener("keydown", handleKeydown);
  window.addEventListener("beforeunload", handleBeforeUnload);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleKeydown);
  window.removeEventListener("beforeunload", handleBeforeUnload);
});
</script>

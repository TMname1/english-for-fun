<template>
  <div class="mx-auto my-8 w-full max-w-screen-lg space-y-5 px-4 md:px-8">
    <div>
      <h2
        class="bg-gradient-to-r from-violet-500 via-fuchsia-500 to-cyan-400 bg-clip-text text-2xl font-bold text-transparent"
      >
        音视频切片转写
      </h2>
      <p class="mt-1 text-sm opacity-70">
        上传音视频 → 时间轴打切点 → 勾选片段 → 只转写选中的部分 → 生成课程
      </p>
      <!--
        【已停用 · 转录校对】原流程为「…转写 → 校对 → 生成课程」，转录后会暂停让你逐句校对文字。
        当前不再需要该人工校对步骤，流水线转录完成后直接续跑结构化 + 对齐。
        校对 UI（step === "review" / ForgeTranscriptReview / handleResume / isAwaitingReview 监听）整段
        注释保留；恢复步骤见 apps/api/src/forge/core/pipeline-runner.ts 顶部说明。
      -->
    </div>

    <div
      class="rounded-lg bg-white px-6 py-6 shadow-even-lg dark:bg-gray-900 dark:shadow-gray-700 md:px-10"
    >
      <ClipUploadForm
        v-if="step === 'upload'"
        :uploading="uploading"
        :upload-percent="uploadPercent"
        @submit="handleUpload"
      />

      <div
        v-else-if="step === 'edit'"
        class="space-y-4"
      >
        <!-- 音频只渲染原生播放条，避免出现 <video> 黑块；两者共用同一套 seek/时长逻辑 -->
        <audio
          v-if="isAudioMedia"
          ref="mediaEl"
          :src="videoUrl"
          controls
          preload="auto"
          class="w-full"
          @loadedmetadata="handleMetadata"
        />
        <video
          v-else
          ref="mediaEl"
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
          :block-reason="submitBlockReason"
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
          快捷键：空格 播放/暂停 · C 在播放头添加切点。5 分钟内的素材不打切点可整段转写；超过 5
          分钟必须先切分，且单个片段不超过 5 分钟（音频按同一规则处理）。
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
          只转写勾选的 {{ submittedClipCount }} 个片段。 转录完成后会自动继续 LLM
          结构化与时间戳对齐。请勿关闭页面。
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

      <!--
        【已停用 · 转录校对】人工校对步骤已从流水线移除，转录完成后直接续跑结构化。
        组件、handleResume、isAwaitingReview 监听与 resume 接口（前后端）均注释保留；
        恢复"转录→校对→结构化"两段式时一并放开（恢复步骤见 apps/api/src/forge/core/pipeline-runner.ts 顶部说明）。
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
      -->

      <div
        v-else-if="step === 'fix' && forge.job.value"
        class="space-y-3"
      >
        <h3 class="text-lg font-semibold">处理未通过的句子</h3>
        <ForgeStructureFix
          :job="forge.job.value"
          @resolve="handleResolveFailures"
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

// 【已停用 · 转录校对】ResumeTranscriptSegment 仅供校对续跑 handleResume 使用，已随之注释保留。
import type { ResolveForgeFailuresDecision } from "~/api/forge";
import type { ClipUploadPayload } from "~/components/VideoClip/ClipUploadForm.vue";
import { createCoursePack } from "~/api/course-pack";
import {
  cancelForgeJob,
  fetchForgeJob,
  resolveForgeJob,
  // 【已停用 · 转录校对】resumeForgeJob：校对续跑接口已停用（见 pipeline-runner.ts 顶部说明）
  // resumeForgeJob,
  startForgeJob,
  uploadForgeJob,
} from "~/api/forge";
import ForgeStructureFix from "~/components/ForgeImport/ForgeStructureFix.vue";
// 【已停用 · 转录校对】ForgeTranscriptReview：人工校对组件已停用，文件保留未删。
// import ForgeTranscriptReview from "~/components/ForgeImport/ForgeTranscriptReview.vue";
import ClipTimeline from "~/components/VideoClip/ClipTimeline.vue";
import ClipToolbar from "~/components/VideoClip/ClipToolbar.vue";
import ClipUploadForm from "~/components/VideoClip/ClipUploadForm.vue";
import { buildCoursePackPayload } from "~/composables/forge/buildCoursePackPayload";
import { useForgeJob } from "~/composables/forge/useForgeJob";
import { validateClipSelection } from "~/composables/videoClip/clipMath";
import { useClipEditor } from "~/composables/videoClip/useClipEditor";
import { useClipPlayer } from "~/composables/videoClip/useClipPlayer";
import { resolveMediaKind } from "~/utils/media";

type Step = "upload" | "edit" | "working" | "review" | "fix" | "failed";

const step = ref<Step>("upload");
const uploading = ref(false);
/** 直传进度（0~1）；B 站下载走服务端，不显示 */
const uploadPercent = ref<number | null>(null);
const submitting = ref(false);
const importing = ref(false);
const jobId = ref<string | null>(null);
const videoUrl = ref("");
/** 播放/预览用的媒体元素：音频与视频共用（都实现 HTMLMediaElement 接口） */
const mediaEl = ref<HTMLMediaElement | null>(null);
/** 媒体类型：由服务端 mediaKind 派生，回退到对象键扩展名 */
const mediaKind = ref<"video" | "audio">("video");
const isAudioMedia = computed(() => mediaKind.value === "audio");
const errorText = ref("");
const submittedClipCount = ref(1);

const editor = useClipEditor();
const player = useClipPlayer(mediaEl);

const submitBlockReason = computed(() =>
  validateClipSelection(editor.duration.value, editor.cuts.value, editor.selectedClips.value),
);
const forge = useForgeJob();

const workingLabel = computed(() => forge.stageLabel.value || "处理中…");

// http 层 reject 的是 NestJS 错误对象（{message, statusCode}）而非 Error，String() 会显示 [object Object]
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (Array.isArray(message)) return message.join("\n");
    if (typeof message === "string" && message) return message;
    return JSON.stringify(error);
  }
  return String(error);
}

// 【已停用 · 转录校对】不再进入 review 步骤：isAwaitingReview 监听注释保留。
// watch(
//   () => forge.isAwaitingReview.value,
//   (awaiting) => {
//     if (awaiting && step.value === "working") step.value = "review";
//   },
// );
watch(
  () => forge.isNeedsFix.value,
  (needs) => {
    if (needs && (step.value === "working" || step.value === "review")) {
      step.value = "fix";
    }
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
  uploadPercent.value = payload.kind === "file" ? 0 : null;
  try {
    let id: string;
    if (payload.kind === "bili") {
      // B 站下载已在服务端建好延迟任务，直接复用 jobId
      id = payload.jobId;
    } else {
      ({ jobId: id } = await uploadForgeJob({
        file: payload.file,
        title: payload.title,
        type: payload.type,
        language: payload.language,
        desc: payload.desc,
        defer: true,
        onProgress: (percent) => {
          uploadPercent.value = percent;
        },
      }));
    }
    jobId.value = id;
    const view = await fetchForgeJob(id);
    videoUrl.value = view.videoPath;
    mediaKind.value = resolveMediaKind(view.mediaKind, view.videoKey ?? view.videoPath);
    editor.reset();
    step.value = "edit";
  } catch (error) {
    toast.error("上传失败：" + describeError(error));
  } finally {
    uploading.value = false;
    uploadPercent.value = null;
  }
}

function handleMetadata() {
  if (mediaEl.value) {
    editor.duration.value = mediaEl.value.duration;
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
    toast.error("启动转写失败：" + describeError(error));
  } finally {
    submitting.value = false;
  }
}

// 【已停用 · 转录校对】校对续跑回调，随 review 步骤一起注释保留（恢复步骤见 pipeline-runner.ts 顶部说明）。
// function handleResume(segments: ResumeTranscriptSegment[]) {
//   if (!jobId.value) return;
//   step.value = "working";
//   void (async () => {
//     try {
//       await resumeForgeJob(jobId.value!, segments);
//       forge.start(jobId.value!);
//     } catch (error) {
//       errorText.value = describeError(error);
//       step.value = "failed";
//     }
//   })();
// }

function handleResolveFailures(decisions: ResolveForgeFailuresDecision[]) {
  if (!jobId.value) return;
  step.value = "working";
  void (async () => {
    try {
      await resolveForgeJob(jobId.value!, decisions);
      forge.start(jobId.value!);
    } catch (error) {
      errorText.value = describeError(error);
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
    errorText.value = describeError(error);
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

import { computed, onScopeDispose, ref } from "vue";

import type { ForgeJobStageValue, ForgeJobView } from "~/api/forge";
import { fetchForgeJob } from "~/api/forge";

const POLL_INTERVAL_MS = 2000;

const STAGE_LABEL: Record<ForgeJobStageValue, string> = {
  pending: "排队中…",
  transcoding: "音频提取中…",
  transcribing: "ASR 转写中…",
  structuring: "LLM 结构化中…",
  aligning: "时间戳对齐中…",
  done: "已完成",
};

/**
 * 轮询 forge 任务进度；非终态时 2s 一次，终态自动停。
 * 网络抖动不停表，下一 tick 接着拉。
 */
export function useForgeJob() {
  const job = ref<ForgeJobView | null>(null);
  const isPolling = ref(false);
  let jobId: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function tick() {
    if (!jobId) return;
    try {
      const view = await fetchForgeJob(jobId);
      job.value = view;
      if (view.status === "done" || view.status === "failed" || view.status === "cancelled") {
        stopPolling();
      }
    } catch {
      // 单次轮询失败：忽略，下一轮再试
    }
  }

  function start(id: string) {
    stopPolling();
    jobId = id;
    isPolling.value = true;
    tick();
    timer = setInterval(tick, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    isPolling.value = false;
  }

  function reset() {
    stopPolling();
    jobId = null;
    job.value = null;
  }

  onScopeDispose(stopPolling);

  const stageLabel = computed(() => {
    if (!job.value) return "";
    return STAGE_LABEL[job.value.stage] ?? job.value.message;
  });
  const isDone = computed(() => job.value?.status === "done");
  const isFailed = computed(() => job.value?.status === "failed");
  const isCancelled = computed(() => job.value?.status === "cancelled");
  const isTerminal = computed(() => isDone.value || isFailed.value || isCancelled.value);
  const elapsedSeconds = computed(() => (job.value ? Math.floor(job.value.elapsedMs / 1000) : 0));
  const errorText = computed(() => job.value?.error ?? "");

  return {
    job,
    isPolling,
    stageLabel,
    isDone,
    isFailed,
    isCancelled,
    isTerminal,
    elapsedSeconds,
    errorText,
    start,
    stopPolling,
    reset,
  };
}

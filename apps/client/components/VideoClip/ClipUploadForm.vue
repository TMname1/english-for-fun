<template>
  <form
    class="space-y-4"
    @submit.prevent="handleSubmit"
  >
    <UTabs
      v-model="source"
      :items="sourceTabs"
      class="w-full"
    />

    <div
      v-if="sourceMode === 'file'"
      class="space-y-4"
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
    </div>

    <div
      v-else
      class="space-y-4"
    >
      <div>
        <div class="mb-1 flex items-center justify-between">
          <label class="block text-sm font-medium">B 站视频链接</label>
          <button
            type="button"
            class="text-xs underline opacity-80"
            @click="toggleLogin"
          >
            {{ loginCardOpen ? "收起" : login ? "重新登录" : "登录（可选，解锁高清）" }}
          </button>
        </div>
        <div class="flex items-center gap-2">
          <UInput
            v-model="biliUrl"
            placeholder="粘贴 BV 号或 b23.tv / bilibili.com 链接"
            class="w-full"
            @keyup.enter="handleParse"
          />
          <UButton
            type="button"
            color="primary"
            variant="outline"
            :loading="parsing"
            :disabled="!biliUrl.trim()"
            @click="handleParse"
          >
            解析
          </UButton>
        </div>

        <div
          v-if="checkingLogin || loginCardOpen"
          class="dark:border-base-700 mt-3 rounded-lg border border-base-200 p-3 text-sm"
        >
          <div
            v-if="checkingLogin"
            class="opacity-70"
          >
            正在检查登录状态…
          </div>
          <template v-else-if="login">
            <div class="flex items-center gap-2">
              <span class="badge badge-success badge-sm gap-1"> 已登录 </span>
              <span class="font-medium">{{ login.uname || "未知用户" }}</span>
              <span
                v-if="login.vipStatus"
                class="badge badge-warning badge-sm"
              >
                大会员
              </span>
            </div>
          </template>
          <template v-else>
            <div
              v-if="!qr"
              class="flex flex-col items-start gap-2"
            >
              <p class="opacity-70">
                登录后下载可解锁更高清晰度（部分视频需登录）。可跳过，直接匿名下载。
              </p>
              <UButton
                type="button"
                size="sm"
                color="primary"
                :loading="startingLogin"
                @click="handleStartLogin"
              >
                生成登录二维码
              </UButton>
            </div>
            <div
              v-else
              class="flex flex-col items-center gap-2"
            >
              <img
                :src="qr.qrDataUrl"
                alt="B 站登录二维码"
                class="dark:border-base-700 h-44 w-44 rounded border border-base-200"
              />
              <p class="text-center text-xs opacity-70">
                {{
                  qrStatus === "scanned"
                    ? "已扫码，请在手机上确认"
                    : qrStatus === "expired"
                      ? "二维码已过期，请重新生成"
                      : "请使用 B 站 App 扫码登录"
                }}
              </p>
              <UButton
                v-if="qrStatus === 'expired'"
                type="button"
                size="xs"
                variant="ghost"
                @click="handleStartLogin"
              >
                重新生成
              </UButton>
            </div>
          </template>
        </div>

        <div
          v-if="info"
          class="dark:border-base-700 mt-3 rounded-lg border border-base-200 p-3 text-sm"
        >
          <div class="min-w-0">
            <p class="truncate font-medium">{{ info.title }}</p>
            <p class="text-xs opacity-60">{{ info.bvid }}</p>
          </div>
        </div>
      </div>

      <div class="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div>
          <label class="mb-1 block text-sm font-medium">清晰度（--qn）</label>
          <select
            v-model="params.qn"
            class="select select-bordered select-sm"
          >
            <option
              v-for="opt in QN_OPTIONS"
              :key="opt.value"
              :value="opt.value"
            >
              {{ opt.label }}
            </option>
          </select>
        </div>
        <div v-if="info && info.pages.length > 1">
          <label class="mb-1 block text-sm font-medium">分 P（--p）</label>
          <select
            v-model.number="params.p"
            class="select select-bordered select-sm"
          >
            <option
              v-for="page in info.pages"
              :key="page.page"
              :value="page.page"
            >
              P{{ page.page }} · {{ page.part }}（{{ formatDuration(page.duration) }}）
            </option>
          </select>
        </div>
        <label class="flex items-center gap-2 pb-2 text-sm">
          <input
            v-model="params.noCookie"
            type="checkbox"
            class="checkbox checkbox-sm"
          />
          <span>不带 Cookie（--no-cookie）</span>
        </label>
      </div>

      <div
        v-if="download"
        class="dark:border-base-700 space-y-2 rounded-lg border border-base-200 p-3"
      >
        <div class="flex items-center justify-between text-sm">
          <span class="font-medium">{{ downloadLabel }}</span>
          <span class="opacity-70">
            {{
              download.total > 0
                ? `${formatSize(download.downloaded)} / ${formatSize(download.total)}`
                : formatSize(download.downloaded)
            }}
          </span>
        </div>
        <progress
          class="progress progress-primary w-full"
          :value="download.total > 0 ? download.percent : undefined"
          :max="download.total > 0 ? 100 : undefined"
        />
        <div class="flex justify-end">
          <UButton
            v-if="download.status === 'running'"
            type="button"
            size="xs"
            color="red"
            variant="ghost"
            @click="handleCancelDownload"
          >
            取消下载
          </UButton>
        </div>
      </div>
    </div>

    <div class="dark:border-base-700 border-t border-base-200 pt-4">
      <label class="mb-1 block text-sm font-medium">
        课程包标题 <span class="text-red-500">*</span>
      </label>
      <UInput
        v-model="form.title"
        :placeholder="sourceMode === 'bili' ? '留空则用解析到的视频标题' : '例如：Friends S01E01'"
        class="w-full"
      />
    </div>

    <div class="flex flex-wrap gap-x-10 gap-y-4">
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
          class="select select-bordered select-sm w-full max-w-xs"
        >
          <option value="en">英语 en</option>
          <option value="zh">中文 zh</option>
          <option value="ja">日语 ja</option>
        </select>
      </div>
    </div>

    <div>
      <label class="mb-1 block text-sm font-medium">描述（可选）</label>
      <UTextarea
        v-model="form.desc"
        :rows="2"
        placeholder="留空则由流水线生成默认描述"
      />
    </div>

    <div class="flex justify-end pt-2">
      <UButton
        type="submit"
        size="lg"
        :loading="submitting"
        :disabled="!canSubmit"
      >
        {{ sourceMode === "bili" ? "下载并进入剪辑" : "上传并进入剪辑" }}
      </UButton>
    </div>
  </form>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { toast } from "vue-sonner";

import type { BiliDownloadView, BiliInfo, BiliLoginStatus } from "~/api/bili";
import {
  cancelBiliDownload,
  fetchBiliDownload,
  getBiliInfo,
  getBiliLoginStatus,
  pollBiliLogin,
  startBiliDownload,
  startBiliLogin,
} from "~/api/bili";

export type ClipUploadPayload =
  | {
      kind: "file";
      file: File;
      title: string;
      type: "dialogue" | "music";
      language: string;
      desc?: string;
    }
  | {
      kind: "bili";
      jobId: string;
    };

const props = defineProps<{ uploading: boolean }>();
const emit = defineEmits<{ (e: "submit", payload: ClipUploadPayload): void }>();

const VIDEO_ACCEPT = ".mp4,.m4v,.mkv,.webm,.mov,.avi";

const QN_OPTIONS = [
  { value: "", label: "自动最高" },
  { value: "1080p60", label: "1080P60 帧" },
  { value: "1080", label: "1080P 高清" },
  { value: "720", label: "720P 准高清" },
  { value: "480", label: "480P 标清" },
  { value: "360", label: "360P 流畅" },
];

const sourceTabs = [{ label: "上传文件" }, { label: "B 站链接" }];

const source = ref(0);
const sourceMode = computed<"file" | "bili">(() => (source.value === 1 ? "bili" : "file"));

const fileInput = ref<HTMLInputElement | null>(null);
const file = ref<File | null>(null);

const biliUrl = ref("");
const parsing = ref(false);
const info = ref<BiliInfo | null>(null);

const params = reactive({
  p: 1,
  qn: "1080",
  noCookie: false,
});

const login = ref<BiliLoginStatus | null>(null);
const checkingLogin = ref(false);
const loginCardOpen = ref(false);
const startingLogin = ref(false);
const qr = ref<{ key: string; qrDataUrl: string } | null>(null);
const qrStatus = ref<"pending" | "scanned" | "expired" | "success">("pending");
let loginTimer: ReturnType<typeof setInterval> | null = null;

const download = ref<BiliDownloadView | null>(null);
let downloadTimer: ReturnType<typeof setInterval> | null = null;
const downloadingInProgress = ref(false);

const form = reactive({
  title: "",
  type: "dialogue" as "dialogue" | "music",
  desc: "",
  language: "en",
});

const submitting = computed(() => props.uploading || downloadingInProgress.value);

const canSubmit = computed(() => {
  if (sourceMode.value === "file") return Boolean(file.value && form.title.trim());
  return (
    Boolean(info.value && biliUrl.value.trim()) &&
    download.value?.status !== "running" &&
    !downloadingInProgress.value
  );
});

const downloadLabel = computed(() => {
  const d = download.value;
  if (!d) return "";
  if (d.status === "done") return "下载完成";
  if (d.status === "failed") return `下载失败：${d.error || "未知错误"}`;
  if (d.status === "cancelled") return "下载已取消";
  return `下载中 · ${d.phase}${d.percent > 0 ? ` ${d.percent.toFixed(1)}%` : ""}`;
});

watch(sourceMode, (mode) => {
  if (mode === "bili" && login.value === null) void refreshLoginStatus();
});

watch(info, (value) => {
  if (value && !form.title.trim()) form.title = value.title;
});

onBeforeUnmount(() => {
  clearLoginTimer();
  clearDownloadTimer();
});

function handleFileChange(event: Event) {
  const target = event.target as HTMLInputElement;
  file.value = target.files?.[0] ?? null;
  if (file.value && !form.title.trim()) {
    form.title = file.value.name.replace(/\.[^.]+$/, "");
  }
}

async function handleSubmit() {
  if (sourceMode.value === "file") {
    if (!file.value || !form.title.trim()) return;
    emit("submit", {
      kind: "file",
      file: file.value,
      title: form.title.trim(),
      type: form.type,
      language: form.language,
      desc: form.desc.trim() || undefined,
    });
    return;
  }

  if (!info.value) return;
  await beginDownload();
}

async function refreshLoginStatus() {
  checkingLogin.value = true;
  try {
    const status = await getBiliLoginStatus();
    login.value = status.isLogin ? status : null;
  } catch {
    login.value = null;
  } finally {
    checkingLogin.value = false;
  }
}

function toggleLogin() {
  if (login.value) {
    login.value = null;
    loginCardOpen.value = true;
    void handleStartLogin();
  } else {
    loginCardOpen.value = !loginCardOpen.value;
  }
}

async function handleStartLogin() {
  startingLogin.value = true;
  clearLoginTimer();
  try {
    const res = await startBiliLogin();
    qr.value = { key: res.key, qrDataUrl: res.qrDataUrl };
    qrStatus.value = "pending";
    loginTimer = setInterval(() => void pollLogin(res.key), 2000);
  } catch (error: any) {
    toast.error("生成登录二维码失败", { description: error?.message });
  } finally {
    startingLogin.value = false;
  }
}

async function pollLogin(key: string) {
  try {
    const res = await pollBiliLogin(key);
    qrStatus.value = res.status;
    if (res.status === "success") {
      clearLoginTimer();
      qr.value = null;
      loginCardOpen.value = false;
      login.value = { isLogin: true, hasCookie: true, uname: res.uname, vipStatus: res.vipStatus };
      toast.success("登录成功", { description: res.uname });
    } else if (res.status === "expired") {
      clearLoginTimer();
    }
  } catch {
    clearLoginTimer();
  }
}

async function handleParse() {
  const url = biliUrl.value.trim();
  if (!url) return;
  parsing.value = true;
  download.value = null;
  try {
    info.value = await getBiliInfo(url);
    params.p = 1;
  } catch (error: any) {
    info.value = null;
    toast.error("解析失败", { description: error?.message });
  } finally {
    parsing.value = false;
  }
}

async function beginDownload() {
  downloadingInProgress.value = true;
  try {
    const { downloadId } = await startBiliDownload({
      url: biliUrl.value.trim(),
      title: form.title.trim() || info.value?.title || "B 站视频",
      type: form.type,
      p: params.p,
      qn: params.qn || undefined,
      noCookie: params.noCookie,
      language: form.language,
      desc: form.desc.trim() || undefined,
    });
    download.value = {
      id: downloadId,
      status: "running",
      phase: "排队中",
      downloaded: 0,
      total: 0,
      percent: 0,
    };
    clearDownloadTimer();
    downloadTimer = setInterval(() => void pollDownload(downloadId), 1000);
  } catch (error: any) {
    downloadingInProgress.value = false;
    toast.error("发起下载失败", { description: error?.message });
  }
}

async function pollDownload(id: string) {
  try {
    const view = await fetchBiliDownload(id);
    download.value = view;
    if (view.status === "done" && view.jobId) {
      clearDownloadTimer();
      downloadingInProgress.value = false;
      emit("submit", { kind: "bili", jobId: view.jobId });
    } else if (view.status === "failed" || view.status === "cancelled") {
      clearDownloadTimer();
      downloadingInProgress.value = false;
      if (view.status === "failed") toast.error("下载失败", { description: view.error });
    }
  } catch (error: any) {
    clearDownloadTimer();
    downloadingInProgress.value = false;
    toast.error("获取下载进度失败", { description: error?.message });
  }
}

async function handleCancelDownload() {
  const id = download.value?.id;
  if (!id) return;
  try {
    await cancelBiliDownload(id);
  } catch (error: any) {
    toast.error("取消下载失败", { description: error?.message });
  }
}

function clearLoginTimer() {
  if (loginTimer) {
    clearInterval(loginTimer);
    loginTimer = null;
  }
}

function clearDownloadTimer() {
  if (downloadTimer) {
    clearInterval(downloadTimer);
    downloadTimer = null;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
</script>

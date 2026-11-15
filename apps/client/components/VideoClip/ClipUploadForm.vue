<template>
  <form
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
      <p class="mt-1 text-xs opacity-70">支持 mp4 / m4v / mkv / webm / mov / avi，单文件最大 2GB</p>
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
        :loading="uploading"
        :disabled="!canSubmit"
      >
        上传并进入剪辑
      </UButton>
    </div>
  </form>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from "vue";

export interface ClipUploadPayload {
  file: File;
  title: string;
  type: "dialogue" | "music";
  language: string;
  desc?: string;
}

defineProps<{ uploading: boolean }>();
const emit = defineEmits<{ (e: "submit", payload: ClipUploadPayload): void }>();

const VIDEO_ACCEPT = ".mp4,.m4v,.mkv,.webm,.mov,.avi";

const fileInput = ref<HTMLInputElement | null>(null);
const file = ref<File | null>(null);
const form = reactive({
  title: "",
  type: "dialogue" as "dialogue" | "music",
  desc: "",
  language: "en",
});

const canSubmit = computed(() => Boolean(file.value && form.title.trim()));

function handleFileChange(event: Event) {
  const target = event.target as HTMLInputElement;
  file.value = target.files?.[0] ?? null;
  if (file.value && !form.title.trim()) {
    form.title = file.value.name.replace(/\.[^.]+$/, "");
  }
}

function handleSubmit() {
  if (!file.value || !form.title.trim()) return;
  emit("submit", {
    file: file.value,
    title: form.title.trim(),
    type: form.type,
    language: form.language,
    desc: form.desc.trim() || undefined,
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
</script>

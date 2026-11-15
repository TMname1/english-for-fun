<template>
  <div class="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
    <div>
      <h2 class="text-2xl font-bold">管理课程</h2>
      <p class="mt-1 text-sm opacity-70">{{ tabDescription }}</p>
      <p
        v-if="activeTab !== 1"
        class="text-sm opacity-70"
      >
        句子以列表形式编辑，每条含 english / chinese / phonetic（上传配套视频后可再加 startTime /
        endTime）；也可用「粘贴 JSON」批量导入。
        <span v-if="activeTab === 0"> 顶部还可用「导入完整 JSON」读取本地课程包文件。</span>
        <span v-else> 保存时会用这里的句子整体替换该课程包原有句子。</span>
      </p>
    </div>

    <UTabs
      v-model="activeTab"
      :items="tabItems"
      class="w-full"
    >
      <template #add>
        <div class="flex flex-col gap-4 pt-4">
          <div class="flex flex-col gap-3">
            <UInput
              v-model="packForm.title"
              placeholder="课程包标题（必填）"
              :ui="{ base: 'font-medium' }"
            />
            <UInput
              v-model="packForm.description"
              placeholder="课程包描述"
            />
            <UInput
              v-model="packForm.cover"
              placeholder="封面图片 URL（可选）"
            />
          </div>

          <div class="flex flex-col gap-2 rounded-lg border p-3 dark:border-gray-700">
            <div class="flex items-center justify-between gap-3">
              <span class="text-sm font-medium">配套视频（本地文件）</span>
              <span class="truncate text-xs opacity-70">{{
                currentVideoLabel(packForm.video)
              }}</span>
            </div>
            <div class="flex items-center gap-2">
              <UButton
                icon="i-ph-film-strip"
                color="gray"
                variant="soft"
                size="sm"
                :loading="isUploadingVideo"
                @click="openVideoPicker('add')"
              >
                {{ packForm.video ? "替换视频" : "上传本地视频" }}
              </UButton>
              <UButton
                v-if="packForm.video"
                icon="i-ph-x"
                color="red"
                variant="ghost"
                size="sm"
                @click="clearVideo('add')"
              >
                移除
              </UButton>
            </div>
            <UInput
              v-model="packForm.video"
              placeholder="或填写站内路径 /course-video/xxx.mp4 / 外部 URL（可选）"
            />
          </div>

          <div class="flex items-center justify-between">
            <h3 class="text-lg font-semibold">课程内容</h3>
            <UButton
              icon="i-ph-file-import"
              color="gray"
              variant="soft"
              size="sm"
              @click="openPackJsonPicker"
            >
              导入完整 JSON
            </UButton>
          </div>

          <div class="flex flex-col gap-3 rounded-lg border p-4 dark:border-gray-700">
            <div class="flex items-center justify-between">
              <span class="font-medium">句子列表</span>
              <UButton
                icon="i-ph-upload-simple"
                color="gray"
                variant="soft"
                size="xs"
                @click="openCourseJsonPicker"
              >
                导入句子 JSON
              </UButton>
            </div>
            <StatementListEditor
              v-model="courseForm.statements"
              :show-timings="!!packForm.video"
            />
          </div>

          <UButton
            color="primary"
            size="lg"
            class="self-start"
            :loading="isSubmitting"
            @click="handleSubmit"
          >
            创建课程包
          </UButton>

          <input
            ref="courseJsonInput"
            type="file"
            accept="application/json,.json"
            class="hidden"
            @change="handleCourseJsonFile"
          />

          <input
            ref="packJsonInput"
            type="file"
            accept="application/json,.json"
            class="hidden"
            @change="handlePackJsonFile"
          />
        </div>
      </template>

      <template #remove>
        <div class="flex flex-col gap-3 pt-4">
          <template v-if="isLoadingPacks">
            <p class="text-sm opacity-70">加载中……</p>
          </template>
          <template v-else-if="coursePackStore.coursePacks.length === 0">
            <p class="text-sm opacity-70">暂无课程包，可在「添加课程」中创建。</p>
          </template>
          <template v-else>
            <div
              v-for="pack in coursePackStore.coursePacks"
              :key="pack.id"
              class="flex items-center justify-between gap-3 rounded-lg border p-4 dark:border-gray-700"
            >
              <div class="min-w-0">
                <p class="truncate font-medium">{{ pack.title }}</p>
                <p class="truncate text-sm opacity-70">{{ pack.description }}</p>
              </div>
              <UButton
                icon="i-ph-trash"
                color="red"
                variant="ghost"
                @click="openDeleteConfirm(pack)"
              />
            </div>
          </template>
        </div>
      </template>

      <template #edit>
        <div class="flex flex-col gap-3 pt-4">
          <template v-if="isLoadingPacks">
            <p class="text-sm opacity-70">加载中……</p>
          </template>
          <template v-else-if="coursePackStore.coursePacks.length === 0">
            <p class="text-sm opacity-70">暂无课程包，可在「添加课程」中创建。</p>
          </template>
          <template v-else>
            <div
              v-for="pack in coursePackStore.coursePacks"
              :key="pack.id"
              class="flex flex-col gap-3 rounded-lg border p-4 dark:border-gray-700"
            >
              <div class="flex items-center justify-between gap-3">
                <div class="min-w-0">
                  <p class="truncate font-medium">{{ pack.title }}</p>
                  <p class="truncate text-sm opacity-70">{{ pack.description }}</p>
                </div>
                <UButton
                  :icon="editingPackId === pack.id ? 'i-ph-x' : 'i-ph-pencil'"
                  :color="editingPackId === pack.id ? 'gray' : 'primary'"
                  variant="ghost"
                  @click="toggleEdit(pack)"
                />
              </div>

              <div
                v-if="editingPackId === pack.id"
                class="flex flex-col gap-3 border-t pt-4 dark:border-gray-700"
              >
                <template v-if="isLoadingEdit">
                  <p class="text-sm opacity-70">正在载入课程数据……</p>
                </template>
                <template v-else>
                  <div class="flex flex-col gap-3">
                    <UInput
                      v-model="editPackForm.title"
                      placeholder="课程包标题（必填）"
                      :ui="{ base: 'font-medium' }"
                    />
                    <UInput
                      v-model="editPackForm.description"
                      placeholder="课程包描述"
                    />
                    <UInput
                      v-model="editPackForm.cover"
                      placeholder="封面图片 URL（可选）"
                    />
                  </div>
                  <div class="flex flex-col gap-2 rounded-lg border p-3 dark:border-gray-700">
                    <div class="flex items-center justify-between gap-3">
                      <span class="text-sm font-medium">配套视频（本地文件）</span>
                      <span class="truncate text-xs opacity-70">
                        {{ currentVideoLabel(editPackForm.video) }}
                      </span>
                    </div>
                    <div class="flex items-center gap-2">
                      <UButton
                        icon="i-ph-film-strip"
                        color="gray"
                        variant="soft"
                        size="sm"
                        :loading="isUploadingVideo"
                        @click="openVideoPicker('edit')"
                      >
                        {{ editPackForm.video ? "替换视频" : "上传本地视频" }}
                      </UButton>
                      <UButton
                        v-if="editPackForm.video"
                        icon="i-ph-x"
                        color="red"
                        variant="ghost"
                        size="sm"
                        @click="clearVideo('edit')"
                      >
                        移除
                      </UButton>
                    </div>
                    <UInput
                      v-model="editPackForm.video"
                      placeholder="或填写站内路径 /course-video/xxx.mp4 / 外部 URL（可选）"
                    />
                  </div>
                  <StatementListEditor
                    v-model="editStatements"
                    :show-timings="!!editPackForm.video"
                  />
                  <div class="flex justify-end gap-3">
                    <UButton
                      color="gray"
                      variant="ghost"
                      :disabled="isEditSubmitting"
                      @click="cancelEdit"
                    >
                      取消
                    </UButton>
                    <UButton
                      color="primary"
                      :loading="isEditSubmitting"
                      @click="saveEdit"
                    >
                      保存修改
                    </UButton>
                  </div>
                </template>
              </div>
            </div>
          </template>
        </div>
      </template>
    </UTabs>

    <div
      v-if="activeTab === 0 || (activeTab === 2 && editingPackId)"
      class="fixed bottom-6 right-6 z-50"
    >
      <UButton
        icon="i-ph-arrow-down"
        color="primary"
        variant="solid"
        aria-label="滚动到页面底部"
        class="aspect-square rounded-full shadow-lg"
        @click="scrollToBottom"
      />
    </div>

    <UModal v-model="showDeleteModal">
      <div class="p-6 text-gray-900 dark:text-white">
        <h3 class="text-xl font-bold">删除课程包</h3>
        <p class="mt-4 text-sm">
          确定删除「{{
            pendingDeletePack?.title
          }}」吗？该课程包下的所有句子和学习进度都会被删除，且无法恢复。
        </p>
        <div class="mt-6 flex justify-end gap-3">
          <UButton
            color="gray"
            variant="ghost"
            :disabled="isDeleting"
            @click="showDeleteModal = false"
          >
            取消
          </UButton>
          <UButton
            color="red"
            :loading="isDeleting"
            @click="confirmDelete"
          >
            确认删除
          </UButton>
        </div>
      </div>
    </UModal>

    <input
      ref="videoInput"
      type="file"
      accept="video/*,.mp4,.m4v,.mkv,.webm,.mov,.avi"
      class="hidden"
      @change="handleVideoFile"
    />

    <p
      v-if="errorMessage"
      class="text-sm text-red-500"
    >
      {{ errorMessage }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { navigateTo } from "#imports";
import { computed, onMounted, ref } from "vue";
import { toast } from "vue-sonner";

import type { CreateCoursePackStatement } from "~/api/course-pack";
import type { CoursePacksItem } from "~/types";
import {
  createCoursePack,
  fetchCoursePackForEdit,
  updateCoursePack,
  uploadCoursePackVideo,
} from "~/api/course-pack";
import StatementListEditor from "~/components/course-pack/StatementListEditor.vue";
import { useCoursePackStore } from "~/store/coursePack";
import {
  buildCreateCoursePackPayload,
  createEmptyCourse,
  parseCourseJsonImport,
  parseCoursePackJsonImport,
} from "~/utils/coursePackManage";

const coursePackStore = useCoursePackStore();

const tabItems = [
  { label: "添加课程", slot: "add" },
  { label: "删除课程", slot: "remove" },
  { label: "修改课程", slot: "edit" },
];
const activeTab = ref(0);
const tabDescription = computed(() => {
  if (activeTab.value === 0) return "创建一个新的课程包。";
  if (activeTab.value === 1) return "删除已有的课程包。";
  return "修改已有课程包的标题、描述、封面与句子。";
});

const packForm = ref({ title: "", description: "", cover: "", video: "" });
const courseForm = ref(createEmptyCourse());
const isSubmitting = ref(false);
const errorMessage = ref("");

const isLoadingPacks = ref(false);
const showDeleteModal = ref(false);
const pendingDeletePack = ref<CoursePacksItem | null>(null);
const isDeleting = ref(false);

// 「修改课程」：列表内展开编辑，一次只编辑一个课程包
const editingPackId = ref<string | null>(null);
const editPackForm = ref({ title: "", description: "", cover: "", video: "" });
const editStatements = ref<CreateCoursePackStatement[]>([]);
const isLoadingEdit = ref(false);
const isEditSubmitting = ref(false);

// 本地视频上传：一次只服务一个表单（添加 / 修改）
const videoInput = ref<HTMLInputElement | null>(null);
const videoTarget = ref<"add" | "edit">("add");
const isUploadingVideo = ref(false);

function openVideoPicker(target: "add" | "edit") {
  videoTarget.value = target;
  videoInput.value?.click();
}

function currentVideoLabel(video: string): string {
  const value = video?.trim();
  if (!value) return "未选择视频";
  if (value.startsWith("/")) return `已上传：${value.split("/").pop()}`;
  return `外部链接：${value}`;
}

function clearVideo(target: "add" | "edit") {
  if (target === "add") packForm.value.video = "";
  else editPackForm.value.video = "";
}

async function handleVideoFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  // 清空选择，保证重复选择同一文件也能再次触发 change
  input.value = "";
  if (!file) return;

  errorMessage.value = "";
  isUploadingVideo.value = true;
  try {
    const { video } = await uploadCoursePackVideo(file);
    if (videoTarget.value === "add") packForm.value.video = video;
    else editPackForm.value.video = video;
    toast.success("视频上传成功");
  } catch (error: unknown) {
    const message = (error as { message?: string })?.message;
    errorMessage.value = message ? `视频上传失败：${message}` : "视频上传失败，请稍后重试";
  } finally {
    isUploadingVideo.value = false;
  }
}

const courseJsonInput = ref<HTMLInputElement | null>(null);

function openCourseJsonPicker() {
  courseJsonInput.value?.click();
}

async function handleCourseJsonFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  // 清空选择，保证重复导入同一个文件也能再次触发 change
  input.value = "";
  if (!file) return;

  const course = courseForm.value;

  errorMessage.value = "";

  let text = "";
  try {
    text = await file.text();
  } catch {
    errorMessage.value = `读取文件「${file.name}」失败`;
    return;
  }

  const result = parseCourseJsonImport(text);
  if (!result.ok) {
    errorMessage.value = `导入「${file.name}」失败：${result.error}`;
    return;
  }

  course.statements = result.statements;
  toast.success(`已导入「${file.name}」，共 ${result.statements.length} 个句子`);
}

const packJsonInput = ref<HTMLInputElement | null>(null);

function openPackJsonPicker() {
  packJsonInput.value?.click();
}

async function handlePackJsonFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  // 清空选择，保证重复导入同一个文件也能再次触发 change
  input.value = "";
  if (!file) return;

  errorMessage.value = "";

  let text = "";
  try {
    text = await file.text();
  } catch {
    errorMessage.value = `读取文件「${file.name}」失败`;
    return;
  }

  const result = parseCoursePackJsonImport(text);
  if (!result.ok) {
    errorMessage.value = `导入「${file.name}」失败：${result.error}`;
    return;
  }
  packForm.value = { ...result.pack };
  courseForm.value = result.course;
  toast.success(`已导入课程包「${result.pack.title}」，确认无误后点击创建`);
}

onMounted(async () => {
  if (coursePackStore.coursePacks.length === 0) {
    isLoadingPacks.value = true;
    try {
      await coursePackStore.setupCoursePacks();
    } finally {
      isLoadingPacks.value = false;
    }
  }
});

function openDeleteConfirm(pack: CoursePacksItem) {
  errorMessage.value = "";
  pendingDeletePack.value = pack;
  showDeleteModal.value = true;
}

async function confirmDelete() {
  const pack = pendingDeletePack.value;
  if (!pack) return;

  errorMessage.value = "";
  isDeleting.value = true;
  try {
    await coursePackStore.removeCoursePack(pack.id);
    showDeleteModal.value = false;
    pendingDeletePack.value = null;
    toast.success(`课程包「${pack.title}」已删除`);
  } catch (error: unknown) {
    // HTTP 错误提示已由 HttpErrorProvider 统一处理，这里补充操作上下文
    const message = (error as { message?: string })?.message;
    errorMessage.value = message ? `删除失败：${message}` : "删除失败，请稍后重试";
  } finally {
    isDeleting.value = false;
  }
}

/** 展开某个课程包的编辑表单并预填数据；再次点击同一行则收起 */
async function toggleEdit(pack: CoursePacksItem) {
  errorMessage.value = "";

  if (editingPackId.value === pack.id) {
    editingPackId.value = null;
    return;
  }

  editingPackId.value = pack.id;
  isLoadingEdit.value = true;
  try {
    const data = await fetchCoursePackForEdit(pack.id);
    editPackForm.value = {
      title: data.title,
      description: data.description,
      cover: data.cover,
      video: data.video ?? "",
    };
    editStatements.value = data.statements;
  } catch (error: unknown) {
    const message = (error as { message?: string })?.message;
    errorMessage.value = message ? `载入失败：${message}` : "载入课程数据失败，请稍后重试";
    editingPackId.value = null;
  } finally {
    isLoadingEdit.value = false;
  }
}

function cancelEdit() {
  editingPackId.value = null;
  errorMessage.value = "";
}

function scrollToBottom() {
  window.scrollTo({
    top: document.documentElement.scrollHeight,
    behavior: "smooth",
  });
}

async function saveEdit() {
  const coursePackId = editingPackId.value;
  if (!coursePackId) return;

  errorMessage.value = "";

  // 复用创建的校验与 payload 构建：课程标题/描述不入库，编辑时留空即可
  const result = buildCreateCoursePackPayload(editPackForm.value, {
    title: "",
    description: "",
    statements: editStatements.value,
  });
  if (!result.ok) {
    errorMessage.value = result.error;
    return;
  }

  isEditSubmitting.value = true;
  try {
    await updateCoursePack(coursePackId, result.payload);
    toast.success("课程包已更新");
    editingPackId.value = null;
    await coursePackStore.setupCoursePacks();
  } catch (error: unknown) {
    // HTTP 错误提示已由 HttpErrorProvider 统一处理，这里补充表单上下文
    const message = (error as { message?: string })?.message;
    errorMessage.value = message ? `更新失败：${message}` : "更新失败，请检查表单内容或服务端状态";
  } finally {
    isEditSubmitting.value = false;
  }
}

async function handleSubmit() {
  errorMessage.value = "";

  const result = buildCreateCoursePackPayload(packForm.value, courseForm.value);
  if (!result.ok) {
    errorMessage.value = result.error;
    return;
  }

  isSubmitting.value = true;
  try {
    await createCoursePack(result.payload);
    toast.success("课程包创建成功");

    await coursePackStore.setupCoursePacks();
    navigateTo("/course-pack");
  } catch (error: unknown) {
    // HTTP 错误提示已由 HttpErrorProvider 统一处理，这里补充表单上下文
    const message = (error as { message?: string })?.message;
    errorMessage.value = message ? `创建失败：${message}` : "创建失败，请检查表单内容或服务端状态";
  } finally {
    isSubmitting.value = false;
  }
}
</script>

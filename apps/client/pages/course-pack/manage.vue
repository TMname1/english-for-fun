<template>
  <div class="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
    <div>
      <h2 class="text-2xl font-bold">管理课程</h2>
      <p class="mt-1 text-sm opacity-70">
        {{ isAddTab ? "创建一个新的课程包" : "删除已有的课程包" }}。
        <template v-if="isAddTab">
          每门课程的句子用 JSON 粘贴，格式：
          <code class="rounded bg-base-200 px-1 dark:bg-gray-700"
            >[{ "english": "...", "chinese": "...", "phonetic": "..." }]</code
          >
        </template>
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

          <div class="flex items-center justify-between">
            <h3 class="text-lg font-semibold">课程列表</h3>
            <UButton
              icon="i-ph-plus"
              color="gray"
              variant="soft"
              @click="addCourse"
            >
              添加课程
            </UButton>
          </div>

          <div
            v-for="(course, index) in courseForms"
            :key="index"
            class="flex flex-col gap-3 rounded-lg border p-4 dark:border-gray-700"
          >
            <div class="flex items-center justify-between">
              <span class="font-medium">第 {{ index + 1 }} 门</span>
              <UButton
                icon="i-ph-trash"
                color="red"
                variant="ghost"
                :disabled="courseForms.length === 1"
                @click="removeCourse(index)"
              />
            </div>
            <UInput
              v-model="course.title"
              placeholder="课程标题（必填）"
            />
            <UInput
              v-model="course.description"
              placeholder="课程描述"
            />
            <UTextarea
              v-model="course.statementsText"
              :rows="6"
              placeholder='[
  { "english": "How are you?", "chinese": "你好吗？", "phonetic": "/haʊ ɑːr ju/" }
]'
              class="font-mono text-sm"
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
    </UTabs>

    <UModal v-model="showDeleteModal">
      <div class="p-6 text-gray-900 dark:text-white">
        <h3 class="text-xl font-bold">删除课程</h3>
        <p class="mt-4 text-sm">
          确定删除「{{
            pendingDeletePack?.title
          }}」吗？该课程包下的所有课程、句子和学习进度都会被删除，且无法恢复。
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

import type { CoursePacksItem } from "~/types";
import type { CourseForm } from "~/utils/coursePackManage";
import { createCoursePack } from "~/api/course-pack";
import { useCoursePackStore } from "~/store/coursePack";
import { buildCreateCoursePackPayload } from "~/utils/coursePackManage";

const coursePackStore = useCoursePackStore();

const tabItems = [
  { label: "添加课程", slot: "add" },
  { label: "删除课程", slot: "remove" },
];
const activeTab = ref(0);
const isAddTab = computed(() => activeTab.value === 0);

const packForm = ref({ title: "", description: "", cover: "" });
const courseForms = ref<CourseForm[]>([createEmptyCourse()]);
const isSubmitting = ref(false);
const errorMessage = ref("");

const isLoadingPacks = ref(false);
const showDeleteModal = ref(false);
const pendingDeletePack = ref<CoursePacksItem | null>(null);
const isDeleting = ref(false);

function createEmptyCourse(): CourseForm {
  return { title: "", description: "", statementsText: "" };
}

function addCourse() {
  courseForms.value.push(createEmptyCourse());
}

function removeCourse(index: number) {
  courseForms.value.splice(index, 1);
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

async function handleSubmit() {
  errorMessage.value = "";

  const result = buildCreateCoursePackPayload(packForm.value, courseForms.value);
  if (!result.ok) {
    errorMessage.value = result.error;
    return;
  }

  isSubmitting.value = true;
  try {
    const response = await createCoursePack(result.payload);
    toast.success(`课程包创建成功，共 ${response.courseIds.length} 门课程`);

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

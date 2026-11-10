<template>
  <div class="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
    <div>
      <h2 class="text-2xl font-bold">管理课程</h2>
      <p class="mt-1 text-sm opacity-70">
        创建一个新的课程包。每门课程的句子用 JSON 粘贴，格式：
        <code class="rounded bg-base-200 px-1 dark:bg-gray-700"
          >[{ "english": "...", "chinese": "...", "phonetic": "..." }]</code
        >
      </p>
    </div>

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

    <p
      v-if="errorMessage"
      class="text-sm text-red-500"
    >
      {{ errorMessage }}
    </p>

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

<script setup lang="ts">
import { navigateTo } from "#imports";
import { ref } from "vue";
import { toast } from "vue-sonner";

import type { CourseForm } from "~/utils/coursePackManage";
import { createCoursePack } from "~/api/course-pack";
import { useCoursePackStore } from "~/store/coursePack";
import { buildCreateCoursePackPayload } from "~/utils/coursePackManage";

const coursePackStore = useCoursePackStore();

const packForm = ref({ title: "", description: "", cover: "" });
const courseForms = ref<CourseForm[]>([createEmptyCourse()]);
const isSubmitting = ref(false);
const errorMessage = ref("");

function createEmptyCourse(): CourseForm {
  return { title: "", description: "", statementsText: "" };
}

function addCourse() {
  courseForms.value.push(createEmptyCourse());
}

function removeCourse(index: number) {
  courseForms.value.splice(index, 1);
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

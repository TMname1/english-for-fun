<template>
  <div class="flex w-full flex-col">
    <template v-if="isLoading">
      <Loading></Loading>
    </template>

    <template v-else>
      <div class="mx-auto flex w-full max-w-xl flex-col items-center gap-6 px-4 py-10">
        <h2 class="text-center text-3xl font-bold dark:border-gray-600">
          {{ coursePackStore.currentCoursePack?.title }}
        </h2>
        <p
          v-if="coursePackStore.currentCoursePack?.description"
          class="text-center text-sm opacity-70"
        >
          {{ coursePackStore.currentCoursePack?.description }}
        </p>
        <p class="text-sm opacity-70">
          已完成学习
          <span class="font-bold text-purple-500">
            {{ coursePackStore.currentCoursePack?.completionCount ?? 0 }}
          </span>
          次
        </p>
        <button
          class="btn btn-primary btn-lg w-full"
          @click="handleStartLearning"
        >
          开始学习
        </button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { navigateTo } from "#app";
import { ref } from "vue";
import { useRoute } from "vue-router";

import { useCoursePackStore } from "~/store/coursePack";

const isLoading = ref(false);
const route = useRoute();
const coursePackStore = useCoursePackStore();
const coursePackId = route.params.id as string;

setup();

async function setup() {
  isLoading.value = true;
  await coursePackStore.setupCoursePack(coursePackId);
  isLoading.value = false;
}

/**
 * "分课程"功能已删除：课程包只有一门课程，直接从课程包进入学习。
 */
function handleStartLearning() {
  navigateTo(`/game/${coursePackId}`);
}
</script>

<style></style>

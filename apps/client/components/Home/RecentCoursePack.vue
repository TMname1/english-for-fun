<template>
  <div class="flex min-h-[350px]">
    <!-- Loading -->
    <div
      v-if="isLoading"
      class="flex flex-1 items-center justify-center"
    >
      <span class="loading loading-dots loading-md"></span>
    </div>
    <div
      v-else
      class="w-full"
    >
      <div
        v-if="coursePacks.length"
        class="grid w-full auto-rows-fr grid-cols-1 gap-4 min-[500px]:grid-cols-2 md:grid-cols-1 min-[850px]:grid-cols-2 xl:grid-cols-3"
      >
        <template
          v-for="coursePack in coursePacks"
          :key="coursePack.coursePackId"
        >
          <CoursePackCard
            :coursePack="{
              id: coursePack.coursePackId,
              title: coursePack.title,
              description: coursePack.description,
            }"
          >
            <template #actions>
              <div class="mt-2 flex justify-between">
                <button
                  class="btn btn-sm tw-btn-blue"
                  @click.stop="gotoCourseList(coursePack.coursePackId)"
                >
                  课程列表
                </button>
                <button
                  class="btn btn-success btn-sm text-white"
                  @click.stop="gotoGame(coursePack.coursePackId)"
                >
                  继续游戏
                </button>
              </div>
            </template>
          </CoursePackCard>
        </template>
      </div>
      <template v-else>
        <div class="flex h-full w-full flex-1 items-center justify-center text-slate-500">
          暂无记录，<NuxtLink
            href="/course-pack"
            class="link text-blue-500 no-underline hover:opacity-75"
            >先学习一课， </NuxtLink
          >再来看看吧~
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { navigateTo } from "#app";
import { ref } from "vue";

import CoursePackCard from "~/components/courses/CoursePackCard.vue";
import { useNavigation } from "~/composables/useNavigation";
import { useRecentCoursePack } from "./helper";

const { gotoCourseList, gotoGame } = useNavigation();
const { coursePacks, fetchCoursePacks } = useRecentCoursePack();
const isLoading = ref(false);

setup();

async function setup() {
  isLoading.value = true;
  try {
    await fetchCoursePacks();
  } catch {
    // 请求失败时保持空列表并展示“暂无记录”，不影响页面其余部分
  } finally {
    isLoading.value = false;
  }
}
</script>

<style scoped></style>

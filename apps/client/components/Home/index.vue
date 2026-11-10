<template>
  <div class="mt-8 w-full">
    <div class="mb-4 flex justify-between border-b pb-2 dark:border-gray-700">
      <div class="text-xl font-medium">最近使用的课程包</div>
      <NuxtLink
        href="/course-pack"
        class="link text-blue-500 no-underline hover:opacity-75"
        >更多课程包
      </NuxtLink>
    </div>
    <HomeRecentCoursePack />
    <HomeCalendarGraph
      class="mt-10"
      :data="learningDailyTimeList"
      :totalLearningTime="learningDailyTotalTime"
      @toggleYear="toggleYear"
    />
  </div>
</template>

<script setup lang="ts">
import { useAsyncData } from "#imports";
import { ref } from "vue";

import { fetchTodayLearningTime } from "~/api/user-learning-activity";
import { useLearningDailyTime } from "~/composables/learningDailyTime";
import { type CalendarDataItem } from "~/composables/user/calendarGraph";
import { useLearningTimeTracker } from "../../composables/main/learningTimeTracker";

const { learningDailyTimeList, learningDailyTotalTime, setupLearningDailyTime } =
  useLearningDailyTime();
const { toggleYear } = useCalendarGraph();

useAsyncData(async () => {
  const { setupLearningTime } = useLearningTimeTracker();
  setupLearningTime(await fetchTodayLearningTime());
});

function useCalendarGraph() {
  const data = ref<CalendarDataItem[]>([]);
  const totalLearningTime = ref<number>(0);

  async function toggleYear() {
    // TODO 需要支持多年份的切换
    setupLearningDailyTime();
  }

  return {
    data,
    totalLearningTime,
    toggleYear,
  };
}
</script>

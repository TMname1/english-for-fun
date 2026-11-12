import { defineStore } from "pinia";
import { ref } from "vue";

import type { CoursePack, CoursePacksItem } from "~/types";
import { fetchCourseHistory } from "~/api/course-history";
import { deleteCoursePack, fetchCoursePack, fetchCoursePacks } from "~/api/course-pack";

export const useCoursePackStore = defineStore("course-pack", () => {
  const coursePacks = ref<CoursePacksItem[]>([]);
  const currentCoursePack = ref<CoursePack>();

  async function setupCoursePacks() {
    const res = await fetchCoursePacks();
    coursePacks.value = res;
  }

  /**
   * 删除课程包并刷新列表。
   */
  async function removeCoursePack(coursePackId: string) {
    await deleteCoursePack(coursePackId);

    coursePacks.value = coursePacks.value.filter((item) => item.id !== coursePackId);
    if (currentCoursePack.value?.id === coursePackId) {
      currentCoursePack.value = undefined;
    }

    await setupCoursePacks();
  }

  async function setupCoursePack(coursePackId: string) {
    if (coursePackId === currentCoursePack.value?.id) return;

    const res = await fetchCoursePack(coursePackId);
    currentCoursePack.value = res;
  }

  /**
   * 刷新课程包级别的学习完成次数（"分课程"功能删除后不再逐课程统计）。
   */
  async function updatePackCompletionCount(coursePackId: string) {
    const history = await fetchCourseHistory(coursePackId);

    if (currentCoursePack.value?.id === coursePackId) {
      currentCoursePack.value.completionCount = history?.completionCount ?? 0;
    }
  }

  return {
    setupCoursePack,
    setupCoursePacks,
    removeCoursePack,
    updatePackCompletionCount,
    currentCoursePack,
    coursePacks,
  };
});

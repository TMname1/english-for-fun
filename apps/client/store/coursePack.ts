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

  async function updateCoursesCompleteCount(coursePackId: string) {
    const courseHistory = await fetchCourseHistory(coursePackId);

    const find = (courseId: string) =>
      courseHistory.find((history) => history.courseId === courseId);

    currentCoursePack.value?.courses.forEach((course) => {
      const matchCourseHistory = find(course.id);

      if (matchCourseHistory) {
        course.completionCount = matchCourseHistory.completionCount;
      }
    });
  }

  return {
    setupCoursePack,
    setupCoursePacks,
    removeCoursePack,
    updateCoursesCompleteCount,
    currentCoursePack,
    coursePacks,
  };
});

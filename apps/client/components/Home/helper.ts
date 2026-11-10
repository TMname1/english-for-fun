import { ref } from "vue";

import { fetchUserRecentCoursePacks } from "~/api/user-course-progress";
import { type UserRecentCoursePack } from "~/types";

const coursePacks = ref<UserRecentCoursePack[]>([]);

const MAX_RECENT_COURSE_PACKS = 3;

export function useRecentCoursePack() {
  async function fetchCoursePacks() {
    // 先清空旧数据，避免请求失败或接口异常时首页一直展示过期的模块级缓存
    coursePacks.value = [];
    const recentCoursePacks = await fetchUserRecentCoursePacks();

    // 按 coursePackId 去重并截断，保证首页最多只渲染 3 张有效卡片
    const seenCoursePackIds = new Set<string>();
    coursePacks.value = recentCoursePacks
      .filter((coursePack) => {
        if (
          !coursePack.coursePackId ||
          !coursePack.title ||
          seenCoursePackIds.has(coursePack.coursePackId)
        ) {
          return false;
        }
        seenCoursePackIds.add(coursePack.coursePackId);
        return true;
      })
      .slice(0, MAX_RECENT_COURSE_PACKS);
  }

  return {
    fetchCoursePacks,
    coursePacks,
  };
}

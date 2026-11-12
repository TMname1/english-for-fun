import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CoursePack, CoursePacksItem } from "~/types";
import { fetchCourseHistory } from "~/api/course-history";
import { deleteCoursePack, fetchCoursePack, fetchCoursePacks } from "~/api/course-pack";
import { useCoursePackStore } from "../coursePack";

vi.mock("~/api/course-pack");
vi.mock("~/api/course-history");

describe("course pack store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("should update pack completion count from course history", async () => {
    const coursePack: CoursePack = {
      id: "coursePackId",
      title: "课程包1",
      description: "这是一个课程包",
      cover: "",
      completionCount: 0,
    };

    vi.mocked(fetchCoursePack).mockImplementation(async () => coursePack);

    vi.mocked(fetchCourseHistory).mockImplementation(async () => {
      return {
        completionCount: 5,
        coursePackId: coursePack.id,
      };
    });

    const coursePackStore = useCoursePackStore();

    await coursePackStore.setupCoursePack(coursePack.id);

    await coursePackStore.updatePackCompletionCount(coursePack.id);

    expect(coursePackStore.currentCoursePack?.completionCount).toBe(5);
  });

  it("removeCoursePack should delete the pack and refresh the list", async () => {
    const packA: CoursePacksItem = { id: "a", title: "课程包A", description: "", cover: "" };
    const packB: CoursePacksItem = { id: "b", title: "课程包B", description: "", cover: "" };

    vi.mocked(fetchCoursePacks)
      .mockResolvedValueOnce([packA, packB])
      .mockResolvedValueOnce([packB]);
    vi.mocked(deleteCoursePack).mockResolvedValue({ deleted: true, coursePackId: "a" });

    const coursePackStore = useCoursePackStore();
    await coursePackStore.setupCoursePacks();
    expect(coursePackStore.coursePacks).toHaveLength(2);

    await coursePackStore.removeCoursePack("a");

    expect(deleteCoursePack).toHaveBeenCalledWith("a");
    expect(coursePackStore.coursePacks.map((item) => item.id)).toEqual(["b"]);
  });
});

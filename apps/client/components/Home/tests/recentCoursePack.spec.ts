import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRecentCoursePack } from "~/types";
import { fetchUserRecentCoursePacks } from "~/api/user-course-progress";
import { useRecentCoursePack } from "../helper";
import RecentCoursePack from "../RecentCoursePack.vue";

vi.mock("~/api/user-course-progress", () => ({
  fetchUserRecentCoursePacks: vi.fn(),
}));

function buildCoursePack(index: number): UserRecentCoursePack {
  return {
    id: index,
    coursePackId: `pack-${index}`,
    title: `课程包${index}`,
    description: `这是课程包${index}`,
  };
}

function mountRecentCoursePack() {
  return mount(RecentCoursePack, {
    global: {
      stubs: {
        NuxtLink: { template: "<a><slot /></a>" },
      },
    },
  });
}

describe("recent course pack", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRecentCoursePack().coursePacks.value = [];
  });

  it("should render at most three deduplicated cards without cover images", async () => {
    vi.mocked(fetchUserRecentCoursePacks).mockResolvedValue([
      buildCoursePack(1),
      buildCoursePack(2),
      buildCoursePack(1),
      buildCoursePack(3),
      buildCoursePack(4),
    ]);

    const wrapper = mountRecentCoursePack();
    await flushPromises();

    expect(wrapper.findAll(".course-pack-card")).toHaveLength(3);
    expect(useRecentCoursePack().coursePacks.value.map((pack) => pack.coursePackId)).toEqual([
      "pack-1",
      "pack-2",
      "pack-3",
    ]);
    expect(wrapper.find("img").exists()).toBe(false);
    expect(wrapper.find("figure").exists()).toBe(false);
  });

  it("should show empty state when there is no valid record", async () => {
    vi.mocked(fetchUserRecentCoursePacks).mockResolvedValue([]);

    const wrapper = mountRecentCoursePack();
    await flushPromises();

    expect(wrapper.text()).toContain("暂无记录");
    expect(wrapper.find(".loading-dots").exists()).toBe(false);
  });

  it("should drop stale cache and stop loading when fetch fails", async () => {
    vi.mocked(fetchUserRecentCoursePacks).mockResolvedValue([buildCoursePack(1)]);
    await useRecentCoursePack().fetchCoursePacks();

    vi.mocked(fetchUserRecentCoursePacks).mockRejectedValue(new Error("network error"));

    const wrapper = mountRecentCoursePack();
    await flushPromises();

    expect(useRecentCoursePack().coursePacks.value).toEqual([]);
    expect(wrapper.find(".course-pack-card").exists()).toBe(false);
    expect(wrapper.find(".loading-dots").exists()).toBe(false);
    expect(wrapper.text()).toContain("暂无记录");
  });
});

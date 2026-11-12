import { createTestingPinia } from "@pinia/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setupPronunciation } from "~/composables/user/pronunciation";
import { useCourseStore } from "~/store/course";
import { play, updateSource } from "../audio";
import { getStatementSoundUrl, useCurrentStatementEnglishSound } from "../index";

vi.mock("../audio.ts", () => {
  return {
    updateSource: vi.fn(),
    play: vi.fn(),
  };
});

setupPronunciation({ apiBase: "http://api.test" });

describe("getStatementSoundUrl", () => {
  it("prefers the real audio clip when the statement has one", () => {
    expect(getStatementSoundUrl({ english: "I like it", audioUrl: "/course-audio/1.mp3" })).toBe(
      "http://api.test/course-audio/1.mp3",
    );
  });

  it("falls back to tts when no clip is attached", () => {
    expect(getStatementSoundUrl({ english: "I like", audioUrl: null })).toContain(
      "http://api.test/tts?",
    );
    expect(getStatementSoundUrl({ english: "I like" })).toContain("text=I%20like");
  });

  it("returns empty url for undefined statement", () => {
    expect(getStatementSoundUrl(undefined)).toBe("");
  });
});

describe("useCurrentStatementEnglishSound", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    createTestingPinia({
      createSpy: vi.fn,
    });

    const courseStore = useCourseStore();
    courseStore.currentStatement = {
      id: "1",
      order: 1,
      english: "I",
      soundmark: "/I/",
      chinese: "我",
      isMastered: false,
    };

    vi.clearAllMocks();
  });

  it("plays sound", async () => {
    const { playSound } = useCurrentStatementEnglishSound();

    playSound();

    expect(play).toHaveBeenCalled();
  });

  it("should updates audio source", async () => {
    useCurrentStatementEnglishSound();

    // update english value
    const courseStore = useCourseStore();
    courseStore.currentStatement = {
      id: "2",
      order: 2,
      english: "like",
      soundmark: "/like/",
      chinese: "喜欢",
      isMastered: false,
    };
    await vi.advanceTimersToNextTimerAsync();

    expect(updateSource).toBeCalledTimes(1);
  });

  it("does not update audio source if the word is the same", async () => {
    useCurrentStatementEnglishSound();

    const courseStore = useCourseStore();
    courseStore.currentStatement = {
      id: "1",
      order: 1,
      english: "I",
      soundmark: "/I/",
      chinese: "我",
      isMastered: false,
    };

    expect(updateSource).toHaveBeenCalledTimes(1);
  });
});

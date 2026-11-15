import { createTestingPinia } from "@pinia/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setupPronunciation } from "~/composables/user/pronunciation";
import { useCourseStore } from "~/store/course";
import { play, updateSource } from "../audio";
import { getStatementSoundUrl, hasVideoTiming, useCurrentStatementEnglishSound } from "../index";
import { playRange, setVideoSource } from "../video";

vi.mock("../audio.ts", () => {
  return {
    updateSource: vi.fn(),
    play: vi.fn(),
  };
});

vi.mock("../video.ts", () => {
  return {
    setVideoSource: vi.fn(),
    playRange: vi.fn(),
  };
});

setupPronunciation({ apiBase: "http://api.test" });

describe("getStatementSoundUrl", () => {
  it("returns the tts url for a statement", () => {
    expect(getStatementSoundUrl({ english: "I like" })).toContain("http://api.test/tts?");
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

describe("video sync playback", () => {
  beforeEach(() => {
    createTestingPinia({ createSpy: vi.fn });
    vi.clearAllMocks();
  });

  it("hasVideoTiming requires video url and both timestamps", () => {
    const statement = { english: "I like", startTime: 1, endTime: 2 };
    expect(hasVideoTiming("/course-video/v.mp4", statement)).toBe(true);
    expect(hasVideoTiming("", statement)).toBe(false);
    expect(hasVideoTiming("/course-video/v.mp4", { english: "I like" })).toBe(false);
    expect(hasVideoTiming("/course-video/v.mp4", undefined)).toBe(false);
  });

  it("playSound seeks the video instead of playing audio when timing exists", () => {
    const courseStore = useCourseStore();
    courseStore.currentLearning = {
      coursePackId: "p1",
      title: "t",
      description: "",
      video: "/course-video/v.mp4",
      statementIndex: 0,
      statements: [],
    };
    courseStore.currentStatement = {
      order: 1,
      english: "I like",
      soundmark: "",
      chinese: "我喜欢",
      startTime: 1.2,
      endTime: 2.5,
      isMastered: false,
    };
    const stopVideo = vi.fn();
    vi.mocked(playRange).mockReturnValue(stopVideo);

    const { playSound } = useCurrentStatementEnglishSound();
    const stop = playSound({ times: 2 });

    expect(setVideoSource).toHaveBeenCalledWith("http://api.test/course-video/v.mp4");
    expect(playRange).toHaveBeenCalledWith(1.2, 2.5, { times: 2 });
    expect(play).not.toHaveBeenCalled();
    expect(stop).toBe(stopVideo);
  });

  it("playSound falls back to audio when statement has no timing", () => {
    const courseStore = useCourseStore();
    courseStore.currentLearning = {
      coursePackId: "p1",
      title: "t",
      description: "",
      video: "/course-video/v.mp4",
      statementIndex: 0,
      statements: [],
    };
    courseStore.currentStatement = {
      order: 1,
      english: "I like",
      soundmark: "",
      chinese: "我喜欢",
      isMastered: false,
    };

    const { playSound } = useCurrentStatementEnglishSound();
    playSound();

    expect(playRange).not.toHaveBeenCalled();
    expect(play).toHaveBeenCalled();
  });

  it("playSound falls back to audio when video is not ready (playRange returns null)", () => {
    const courseStore = useCourseStore();
    courseStore.currentLearning = {
      coursePackId: "p1",
      title: "t",
      description: "",
      video: "/course-video/v.mp4",
      statementIndex: 0,
      statements: [],
    };
    courseStore.currentStatement = {
      order: 1,
      english: "I like",
      soundmark: "",
      chinese: "我喜欢",
      startTime: 1,
      endTime: 2,
      isMastered: false,
    };
    vi.mocked(playRange).mockReturnValue(null);

    const { playSound } = useCurrentStatementEnglishSound();
    playSound();

    expect(play).toHaveBeenCalled();
  });
});

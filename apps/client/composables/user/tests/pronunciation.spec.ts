import { beforeEach, describe, expect, it } from "vitest";

import { PronunciationType, setupPronunciation, usePronunciation } from "../pronunciation";

const PRONUNCIATION_TYPE = "pronunciationType";
const API_BASE = "http://localhost:3001";

function expectPronunciation(type: PronunciationType) {
  const { pronunciation } = usePronunciation();

  expect(pronunciation.value).toBe(type);
  expect(localStorage.getItem(PRONUNCIATION_TYPE)).toBe(type);
}

describe("pronunciation", () => {
  beforeEach(() => {
    const { pronunciation } = usePronunciation();
    pronunciation.value = PronunciationType.American;
    localStorage.clear();
    setupPronunciation({ apiBase: API_BASE });
  });

  it("get default pronunciation if it was stored", () => {
    localStorage.setItem(PRONUNCIATION_TYPE, PronunciationType.British);

    expectPronunciation(PronunciationType.British);
  });

  it("get default pronunciation if it wasn't stored", () => {
    expectPronunciation(PronunciationType.American);
  });

  it("get pronunciation options", () => {
    const { getPronunciationOptions } = usePronunciation();

    expect(getPronunciationOptions()).toEqual([
      { label: "美音", value: "American" },
      { label: "英音", value: "British" },
    ]);
  });

  it("toggle pronunciation", () => {
    const { togglePronunciation } = usePronunciation();

    togglePronunciation(PronunciationType.British);

    expectPronunciation(PronunciationType.British);
  });

  it("builds tts url with encoded text", () => {
    const { getPronunciationUrl } = usePronunciation();

    expect(getPronunciationUrl("british english")).toBe(
      `${API_BASE}/tts?accent=American&text=british%20english`,
    );
  });

  it("escapes url-significant characters in the text", () => {
    const { getPronunciationUrl } = usePronunciation();

    expect(getPronunciationUrl("a # b & c?")).toBe(
      `${API_BASE}/tts?accent=American&text=a%20%23%20b%20%26%20c%3F`,
    );
  });

  it("uses the selected accent in the url", () => {
    const { getPronunciationUrl, togglePronunciation } = usePronunciation();

    togglePronunciation(PronunciationType.British);

    expect(getPronunciationUrl("hello")).toBe(`${API_BASE}/tts?accent=British&text=hello`);
  });

  it("returns an empty url for empty input", () => {
    const { getPronunciationUrl } = usePronunciation();

    expect(getPronunciationUrl(undefined)).toBe("");
    expect(getPronunciationUrl("")).toBe("");
    expect(getPronunciationUrl("   ")).toBe("");
  });

  describe("resolveAudioUrl", () => {
    it("joins relative clip paths with the api base", () => {
      const { resolveAudioUrl } = usePronunciation();

      expect(resolveAudioUrl("/course-audio/a.mp3")).toBe(`${API_BASE}/course-audio/a.mp3`);
      expect(resolveAudioUrl("course-audio/a.mp3")).toBe(`${API_BASE}/course-audio/a.mp3`);
    });

    it("keeps absolute urls untouched", () => {
      const { resolveAudioUrl } = usePronunciation();

      expect(resolveAudioUrl("https://cdn.example.com/a.mp3")).toBe(
        "https://cdn.example.com/a.mp3",
      );
    });

    it("returns an empty url for null/undefined/empty", () => {
      const { resolveAudioUrl } = usePronunciation();

      expect(resolveAudioUrl(undefined)).toBe("");
      expect(resolveAudioUrl(null)).toBe("");
      expect(resolveAudioUrl("   ")).toBe("");
    });
  });
});

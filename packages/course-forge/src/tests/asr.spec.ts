import { describe, expect, it } from "vitest";

import { asrComposeStopArgs, parseTranscription } from "../asr";

describe("parseTranscription", () => {
  it("keeps word-level timestamps when present", () => {
    const json = {
      segments: [
        {
          id: 0,
          start: 0.1,
          end: 2.0,
          text: " I like the food. ",
          words: [
            { word: " I", start: 0.1, end: 0.3 },
            { word: " like", start: 0.4, end: 0.7 },
            { word: " the", start: 0.8, end: 0.9 },
            { word: " food.", start: 1.0, end: 1.9 },
          ],
        },
      ],
    };
    const t = parseTranscription(json, "en");
    expect(t.wordLevel).toBe(true);
    expect(t.segments[0].text).toBe("I like the food.");
    expect(t.segments[0].words).toHaveLength(4);
    expect(t.segments[0].words![0].word).toBe("I");
  });

  it("degrades to segment level when words are missing or invalid", () => {
    const json = {
      segments: [
        { id: 0, start: 0, end: 2, text: "Hello there.", words: [] },
        {
          id: 1,
          start: 2,
          end: 4,
          text: "General Kenobi.",
          words: [{ word: "General", start: null, end: undefined }],
        },
      ],
    };
    const t = parseTranscription(json, "en");
    expect(t.wordLevel).toBe(false);
    expect(t.segments).toHaveLength(2);
    expect(t.segments[0].words).toBeUndefined();
    expect(t.segments[1].words).toBeUndefined();
  });

  it("drops segments with invalid timing", () => {
    const json = {
      segments: [
        { start: NaN, end: 1, text: "oops" },
        { start: 1, end: 2, text: "ok", words: [{ word: "ok", start: 1, end: 2 }] },
      ],
    };
    const t = parseTranscription(json, "en");
    expect(t.segments).toHaveLength(1);
    expect(t.wordLevel).toBe(true);
  });

  it("throws on empty transcription", () => {
    expect(() => parseTranscription({ segments: [] }, "en")).toThrow(/转写结果为空/);
    expect(() => parseTranscription({}, "en")).toThrow(/转写结果为空/);
  });
});

describe("asrComposeStopArgs", () => {
  it("stops only the asr service of the asr profile (symmetric with startup)", () => {
    expect(asrComposeStopArgs()).toEqual(["compose", "--profile", "asr", "stop", "asr"]);
  });
});

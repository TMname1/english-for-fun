import { normalizeEditedTranscript } from "../transcript-edit";

describe("normalizeEditedTranscript", () => {
  it("rebuilds segment text from edited word texts and keeps word timings", () => {
    const raw = {
      segments: [
        {
          id: 0,
          start: 0.1,
          end: 1.9,
          text: "I like tha food.",
          words: [
            { word: "I", start: 0.1, end: 0.3 },
            { word: "like", start: 0.4, end: 0.7 },
            { word: "the", start: 0.8, end: 0.9 },
            { word: "food.", start: 1.0, end: 1.9 },
          ],
        },
      ],
    };
    const t = normalizeEditedTranscript(raw, "en");
    expect(t.wordLevel).toBe(true);
    expect(t.segments[0].text).toBe("I like the food.");
    expect(t.segments[0].words).toHaveLength(4);
    // 文字被修正，但每个词的 start/end 不变
    expect(t.segments[0].words![2]).toEqual({ word: "the", start: 0.8, end: 0.9 });
  });

  it("drops deleted segments (absent from input) and keeps the rest", () => {
    const raw = {
      segments: [
        { id: 0, start: 0, end: 1, words: [{ word: "Hello", start: 0, end: 1 }] },
        { id: 2, start: 4, end: 5, words: [{ word: "Bye", start: 4, end: 5 }] },
      ],
    };
    const t = normalizeEditedTranscript(raw, "en");
    expect(t.segments).toHaveLength(2);
    expect(t.segments.map((s) => s.id)).toEqual([0, 2]);
  });

  it("ignores words with invalid timing or empty text", () => {
    const raw = {
      segments: [
        {
          id: 0,
          start: 0,
          end: 2,
          words: [
            { word: "ok", start: 0, end: 1 },
            { word: "", start: 1, end: 2 },
            { word: "nan", start: null, end: undefined },
          ],
        },
      ],
    };
    const t = normalizeEditedTranscript(raw, "en");
    expect(t.segments[0].words).toHaveLength(1);
    expect(t.segments[0].text).toBe("ok");
  });

  it("keeps a segment-level fallback when only text is present", () => {
    const raw = { segments: [{ id: 0, start: 0, end: 2, text: "General Kenobi." }] };
    const t = normalizeEditedTranscript(raw, "en");
    expect(t.wordLevel).toBe(false);
    expect(t.segments[0].words).toBeUndefined();
    expect(t.segments[0].text).toBe("General Kenobi.");
  });

  it("throws when every segment is empty or removed", () => {
    expect(() => normalizeEditedTranscript({ segments: [] }, "en")).toThrow(/没有有效的转录分段/);
    expect(() =>
      normalizeEditedTranscript(
        { segments: [{ id: 0, words: [{ word: " ", start: 0, end: 1 }] }] },
        "en",
      ),
    ).toThrow(/没有有效的转录分段/);
  });
});

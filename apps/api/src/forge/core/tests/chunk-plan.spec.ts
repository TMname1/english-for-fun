import type { QwenAsrSentence } from "../asr-model";
import { planChunks, repairChunkBoundaries, selectWordsInCore, splitSpan } from "../chunk-plan";

const MAX = 180_000;
const PAD = 200;

describe("splitSpan", () => {
  it("不超上限时原样返回", () => {
    expect(splitSpan({ start: 0, end: MAX }, MAX)).toEqual([{ start: 0, end: MAX }]);
  });

  it("超长区间等分（不会切出只剩几百毫秒的尾巴）", () => {
    const parts = splitSpan({ start: 0, end: 400_000 }, MAX);
    expect(parts).toHaveLength(3);
    expect(parts[0].start).toBe(0);
    expect(parts[parts.length - 1].end).toBe(400_000);
    for (const p of parts) expect(p.end - p.start).toBeLessThanOrEqual(MAX);
    // 段与段首尾相接，不重叠、不缺口
    for (let i = 1; i < parts.length; i += 1) expect(parts[i].start).toBe(parts[i - 1].end);
  });

  it("非法区间返回空数组", () => {
    expect(splitSpan({ start: 100, end: 100 }, MAX)).toEqual([]);
  });
});

describe("planChunks", () => {
  const base = { unitIndex: 0, clipIndex: 0, maxMs: MAX, padMs: PAD };

  it("相邻句子恰好装到上限时仍是一块", () => {
    const chunks = planChunks({
      ...base,
      spans: [
        { start: 0, end: 100_000 },
        { start: 100_000, end: 180_000 },
      ],
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].core).toEqual({ start: 0, end: 180_000 });
  });

  it("再超 1ms 就拆成两块，且 core 首尾相接不重叠", () => {
    const chunks = planChunks({
      ...base,
      spans: [
        { start: 0, end: 180_000 },
        { start: 180_000, end: 181_000 },
      ],
    });
    expect(chunks).toHaveLength(2);
    expect(chunks[0].core).toEqual({ start: 0, end: 180_000 });
    expect(chunks[1].core).toEqual({ start: 180_000, end: 181_000 });
    expect(chunks[1].core.start).toBe(chunks[0].core.end);
  });

  it("单个超长句等分，每块都不超上限", () => {
    const chunks = planChunks({ ...base, spans: [{ start: 0, end: 400_000 }] });
    expect(chunks).toHaveLength(3);
    for (const c of chunks) expect(c.core.end - c.core.start).toBeLessThanOrEqual(MAX);
  });

  it("padding 会 clamp 到 clip 边界，不借区间外的音频", () => {
    const chunks = planChunks({
      ...base,
      clip: { start: 10, end: 20 },
      spans: [{ start: 10_000, end: 20_000 }],
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].audio).toEqual({ start: 10_000, end: 20_000 });
    expect(chunks[0].local).toEqual({ start: 0, end: 10_000 });
  });

  it("无切片时用 unitDurationMs clamp 上界，local 相对 unit 起点", () => {
    const chunks = planChunks({
      ...base,
      spans: [{ start: 5_000, end: 6_000 }],
      unitDurationMs: 6_000,
    });
    expect(chunks[0].audio).toEqual({ start: 4_800, end: 6_000 });
    expect(chunks[0].local).toEqual({ start: 4_800, end: 6_000 });
  });

  it("clip 起点不是 0 时，local 减去 baseMs（避免整体偏移一个 clip.start）", () => {
    const chunks = planChunks({
      ...base,
      clip: { start: 100, end: 200 },
      spans: [{ start: 100_000, end: 101_000 }],
    });
    expect(chunks[0].audio).toEqual({ start: 100_000, end: 101_200 });
    expect(chunks[0].local).toEqual({ start: 0, end: 1_200 });
  });

  it("空 spans 返回空计划", () => {
    expect(planChunks({ ...base, spans: [] })).toEqual([]);
  });

  it("首块向左、末块向右扩展归属窗口到 padding 边缘（避免丢开头/结尾的词）", () => {
    const chunks = planChunks({ ...base, spans: [{ start: 1_000, end: 2_000 }] });
    expect(chunks[0].core).toEqual({ start: 1_000, end: 2_000 });
    expect(chunks[0].audio).toEqual({ start: 800, end: 2_200 });
    expect(chunks[0].keep).toEqual({ start: 800, end: 2_200 });
  });

  it("相邻块之间的归属窗口不扩展（靠 core 去重）", () => {
    const chunks = planChunks({
      ...base,
      spans: [
        { start: 0, end: 180_000 },
        { start: 180_000, end: 181_000 },
      ],
    });
    expect(chunks[0].keep).toEqual({ start: 0, end: 180_000 });
    expect(chunks[1].keep).toEqual({ start: 180_000, end: 181_200 });
  });

  it("丢弃越界与倒序的段", () => {
    const chunks = planChunks({
      ...base,
      clip: { start: 10, end: 20 },
      spans: [
        { start: 20_000, end: 21_000 },
        { start: 12_000, end: 12_000 },
        { start: 10_500, end: 11_000 },
      ],
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].core).toEqual({ start: 10_500, end: 11_000 });
  });
});

describe("selectWordsInCore", () => {
  const core = { start: 0, end: 1_000 };

  it("按词中点判定归属：中点落在 core.end 上要丢弃（半开区间）", () => {
    const words = [
      { text: " a", begin_time: 0, end_time: 200 }, // mid 100 → 保留
      { text: " b", begin_time: 900, end_time: 1_100 }, // mid 1000 → 丢弃
      { text: " c", begin_time: 400, end_time: 600 }, // mid 500 → 保留
    ];
    const { kept, dropped } = selectWordsInCore(words, core, 0);
    expect(kept.map((k) => k.raw.text)).toEqual([" a", " c"]);
    expect(dropped).toBe(1);
  });

  it("把块内相对时间偏移成绝对时间", () => {
    const { kept } = selectWordsInCore(
      [{ text: " hi", begin_time: 100, end_time: 600 }],
      { start: 10_000, end: 11_000 },
      10_000,
    );
    expect(kept[0].beginMs).toBe(10_100);
    expect(kept[0].endMs).toBe(10_600);
  });

  it("缺时间戳的词按丢弃处理", () => {
    const { kept, dropped } = selectWordsInCore([{ text: " x" }], core, 0);
    expect(kept).toHaveLength(0);
    expect(dropped).toBe(1);
  });

  it("首块用 keep 判定时，core 之前的开头词不再被丢弃", () => {
    const chunks = planChunks({
      unitIndex: 0,
      clipIndex: 0,
      spans: [{ start: 1_000, end: 2_000 }],
      maxMs: MAX,
      padMs: PAD,
    });
    // 词在块音频起点后 0~120ms → 绝对 800~920，中点 860：在 keep 内、在 core 外
    const words = [{ text: " One", begin_time: 0, end_time: 120 }];
    expect(selectWordsInCore(words, chunks[0].keep, chunks[0].audio.start).kept).toHaveLength(1);
    expect(selectWordsInCore(words, chunks[0].core, chunks[0].audio.start).kept).toHaveLength(0);
  });
});

describe("repairChunkBoundaries", () => {
  it("把被块边界拦腰拆开的词拼回去", () => {
    const sentences: QwenAsrSentence[] = [
      {
        begin_time: 0,
        end_time: 5_000,
        text: "This is Genu",
        words: [
          { text: " This", begin_time: 0, end_time: 500 },
          { text: " is", begin_time: 500, end_time: 1_500 },
          { text: " Genu", begin_time: 4_800, end_time: 5_000 },
        ],
      },
      {
        begin_time: 4_990,
        end_time: 6_000,
        text: "inely good",
        words: [
          { text: "inely", begin_time: 4_990, end_time: 5_600 },
          { text: " good", begin_time: 5_600, end_time: 6_000 },
        ],
      },
    ];
    const { sentences: repaired, merged } = repairChunkBoundaries(sentences);
    expect(merged).toBe(1);
    expect(repaired[0].words?.[2].text).toBe("Genuinely");
    expect(repaired[0].words?.[2].end_time).toBe(5_600);
    // 第二块剩下的词保留，文本同步更新（避免出现空块）
    expect(repaired[1].words?.map((w) => w.text)).toEqual([" good"]);
    expect(repaired[1].begin_time).toBe(5_600);
  });

  it("有前导空格说明是两个独立的词，不合并", () => {
    const sentences: QwenAsrSentence[] = [
      { begin_time: 0, end_time: 1_000, words: [{ text: " end", begin_time: 0, end_time: 1_000 }] },
      {
        begin_time: 1_000,
        end_time: 2_000,
        words: [{ text: " Start", begin_time: 1_000, end_time: 2_000 }],
      },
    ];
    expect(repairChunkBoundaries(sentences).merged).toBe(0);
  });

  it("间距过大不合并（不是同一个词）", () => {
    const sentences: QwenAsrSentence[] = [
      { begin_time: 0, end_time: 1_000, words: [{ text: " foo", begin_time: 0, end_time: 1_000 }] },
      {
        begin_time: 1_500,
        end_time: 2_000,
        words: [{ text: "bar", begin_time: 1_500, end_time: 2_000 }],
      },
    ];
    expect(repairChunkBoundaries(sentences).merged).toBe(0);
  });
});

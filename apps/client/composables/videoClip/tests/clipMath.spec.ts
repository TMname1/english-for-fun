import { describe, expect, it } from "vitest";

import {
  addCut,
  cutsToClips,
  formatDuration,
  formatTimecode,
  MAX_CLIP_SECONDS,
  validateClipSelection,
} from "../clipMath";

describe("cutsToClips", () => {
  it("无切点时整段为一个 clip", () => {
    expect(cutsToClips([], 30)).toEqual([{ start: 0, end: 30 }]);
  });

  it("切点分割为相邻区间", () => {
    expect(cutsToClips([10, 20], 30)).toEqual([
      { start: 0, end: 10 },
      { start: 10, end: 20 },
      { start: 20, end: 30 },
    ]);
  });

  it("duration 为 0 时返回空", () => {
    expect(cutsToClips([], 0)).toEqual([]);
  });
});

describe("addCut", () => {
  it("插入并保持排序", () => {
    expect(addCut([10], 5, 30)).toEqual([5, 10]);
  });

  it("clamp 越界时间", () => {
    expect(addCut([], -5, 30)).toEqual([]);
    expect(addCut([], 100, 30)).toEqual([]);
    expect(addCut([], 15, 30)).toEqual([15]);
  });

  it("距端点或已有切点过近时忽略（返回原数组）", () => {
    const cuts = [10];
    expect(addCut(cuts, 0.01, 30)).toBe(cuts);
    expect(addCut(cuts, 29.99, 30)).toBe(cuts);
    expect(addCut(cuts, 10.02, 30)).toBe(cuts);
  });
});

describe("validateClipSelection", () => {
  const LONG = MAX_CLIP_SECONDS + 10;

  it("5 分钟内不打切点可整段提交", () => {
    expect(validateClipSelection(120, [], [{ start: 0, end: 120 }])).toBeNull();
  });

  it("超过 5 分钟未打切点被拦截", () => {
    expect(validateClipSelection(LONG, [], [{ start: 0, end: LONG }])).toMatch(/超过 5 分钟/);
  });

  it("选中片段超过 5 分钟被拦截", () => {
    expect(
      validateClipSelection(
        LONG * 2,
        [60],
        [
          { start: 0, end: 60 },
          { start: 60, end: 60 + LONG },
        ],
      ),
    ).toMatch(/超过 5 分钟/);
  });

  it("切分后每段都在 5 分钟内则放行", () => {
    expect(
      validateClipSelection(
        500,
        [MAX_CLIP_SECONDS],
        [
          { start: 0, end: MAX_CLIP_SECONDS },
          { start: MAX_CLIP_SECONDS, end: 500 },
        ],
      ),
    ).toBeNull();
  });

  it("恰好 5 分钟的片段视为合规", () => {
    expect(
      validateClipSelection(600, [MAX_CLIP_SECONDS], [{ start: 0, end: MAX_CLIP_SECONDS }]),
    ).toBeNull();
  });

  it("duration 未知或未勾选片段时不报错", () => {
    expect(validateClipSelection(0, [], [])).toBeNull();
    expect(validateClipSelection(LONG, [], [])).toBeNull();
  });
});

describe("formatTimecode", () => {
  it("分:秒.十分位", () => {
    expect(formatTimecode(0)).toBe("0:00.0");
    expect(formatTimecode(65.25)).toBe("1:05.3");
  });

  it("超过一小时带小时位", () => {
    expect(formatTimecode(3661)).toBe("1:01:01.0");
  });
});

describe("formatDuration", () => {
  it("短于 1 分钟用秒", () => {
    expect(formatDuration(12.34)).toBe("12.3s");
  });

  it("长于 1 分钟用分秒", () => {
    expect(formatDuration(125)).toBe("2m05s");
  });
});

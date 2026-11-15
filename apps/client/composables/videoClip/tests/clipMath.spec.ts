import { describe, expect, it } from "vitest";

import { addCut, cutsToClips, formatDuration, formatTimecode } from "../clipMath";

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

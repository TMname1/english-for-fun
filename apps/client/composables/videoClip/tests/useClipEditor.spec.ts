import { describe, expect, it } from "vitest";

import { useClipEditor } from "../useClipEditor";

function setup(duration = 30) {
  const editor = useClipEditor();
  editor.duration.value = duration;
  return editor;
}

describe("useClipEditor", () => {
  it("初始为单个全选 clip", () => {
    const editor = setup();
    expect(editor.clips.value).toEqual([{ start: 0, end: 30, index: 0, selected: true }]);
    expect(editor.selectedSeconds.value).toBe(30);
  });

  it("加切点后两半继承勾选状态", () => {
    const editor = setup();
    editor.toggleClip(0); // 取消全选
    expect(editor.addCutAt(10)).toBe(true);
    expect(editor.clips.value.map((c) => c.selected)).toEqual([false, false]);

    editor.toggleClip(1);
    editor.addCutAt(20);
    expect(editor.clips.value.map((c) => c.selected)).toEqual([false, true, true]);
  });

  it("忽略非法切点", () => {
    const editor = setup();
    expect(editor.addCutAt(0.01)).toBe(false);
    expect(editor.addCutAt(29.99)).toBe(false);
    editor.addCutAt(10);
    expect(editor.addCutAt(10.01)).toBe(false);
    expect(editor.cuts.value).toEqual([10]);
  });

  it("删切点合并区间，勾选取两侧之或", () => {
    const editor = setup();
    editor.addCutAt(10);
    editor.toggleClip(0); // [false, true]
    editor.removeCut(10);
    expect(editor.clips.value).toEqual([{ start: 0, end: 30, index: 0, selected: true }]);
  });

  it("selectedClips 只含勾选区间，供提交", () => {
    const editor = setup();
    editor.addCutAt(10);
    editor.addCutAt(20);
    editor.toggleClip(1);
    expect(editor.selectedClips.value).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 30 },
    ]);
    expect(editor.selectedSeconds.value).toBe(20);
  });

  it("selectAll / reset", () => {
    const editor = setup();
    editor.addCutAt(15);
    editor.selectAll(false);
    expect(editor.selectedClips.value).toEqual([]);
    editor.selectAll(true);
    expect(editor.selectedClips.value).toHaveLength(2);
    editor.reset();
    expect(editor.cuts.value).toEqual([]);
    expect(editor.clips.value).toEqual([]);
  });
});

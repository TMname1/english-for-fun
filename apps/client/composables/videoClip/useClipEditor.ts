import { computed, ref } from "vue";

import type { ClipSpan } from "./clipMath";
import { addCut, cutsToClips } from "./clipMath";

export interface EditorClip extends ClipSpan {
  index: number;
  selected: boolean;
}

/**
 * 切点编辑状态：clips 由 cuts 派生；勾选状态在增删切点时按区间归属迁移
 * （加切点：两半继承原区间勾选；删切点：合并区间取两侧之或）。
 */
export function useClipEditor() {
  const duration = ref(0);
  const cuts = ref<number[]>([]);
  const selectedFlags = ref<boolean[]>([true]);

  const clips = computed<EditorClip[]>(() =>
    cutsToClips(cuts.value, duration.value).map((span, index) => ({
      ...span,
      index,
      selected: selectedFlags.value[index] ?? true,
    })),
  );

  const selectedClips = computed<ClipSpan[]>(() =>
    clips.value.filter((c) => c.selected).map(({ start, end }) => ({ start, end })),
  );

  const selectedSeconds = computed(() =>
    selectedClips.value.reduce((sum, c) => sum + (c.end - c.start), 0),
  );

  function remapFlags(nextCuts: number[]) {
    const oldClips = clips.value;
    const nextSpans = cutsToClips(nextCuts, duration.value);
    selectedFlags.value = nextSpans.map((span) => {
      const mid = (span.start + span.end) / 2;
      const owner = oldClips.find((c) => mid >= c.start && mid <= c.end);
      return owner ? owner.selected : true;
    });
    cuts.value = nextCuts;
  }

  /** 返回是否实际加入（贴端点/重复位置会被忽略） */
  function addCutAt(time: number): boolean {
    const next = addCut(cuts.value, time, duration.value);
    if (next === cuts.value) return false;
    remapFlags(next);
    return true;
  }

  function removeCut(cut: number) {
    const next = cuts.value.filter((c) => c !== cut);
    if (next.length === cuts.value.length) return;
    // 合并区间取两侧之或：先按中点继承，再把被删切点两侧的勾选合并进来
    const idx = cuts.value.indexOf(cut);
    const leftSelected = selectedFlags.value[idx] ?? true;
    const rightSelected = selectedFlags.value[idx + 1] ?? true;
    remapFlags(next);
    selectedFlags.value[idx] = leftSelected || rightSelected;
  }

  function toggleClip(index: number) {
    const flags = [...selectedFlags.value];
    flags[index] = !(flags[index] ?? true);
    selectedFlags.value = flags;
  }

  function selectAll(value: boolean) {
    selectedFlags.value = clips.value.map(() => value);
  }

  function reset() {
    duration.value = 0;
    cuts.value = [];
    selectedFlags.value = [true];
  }

  return {
    duration,
    cuts,
    clips,
    selectedClips,
    selectedSeconds,
    addCutAt,
    removeCut,
    toggleClip,
    selectAll,
    reset,
  };
}

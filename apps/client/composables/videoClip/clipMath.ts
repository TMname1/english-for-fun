export const CUT_EPS = 0.05;

/** 与后端 / course-forge 的 ASR 单段 5 分钟上限保持一致 */
export const MAX_CLIP_SECONDS = 300;

export interface ClipSpan {
  start: number;
  end: number;
}

/** 切点数组 → 相邻区间；cuts 须已排序且在 (0, duration) 内 */
export function cutsToClips(cuts: number[], duration: number): ClipSpan[] {
  if (duration <= 0) return [];
  const bounds = [0, ...cuts, duration];
  const clips: ClipSpan[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    if (bounds[i + 1] - bounds[i] > CUT_EPS) {
      clips.push({ start: bounds[i], end: bounds[i + 1] });
    }
  }
  return clips;
}

/** 加入切点：clamp 到 [0,duration]，与端点或已有切点距离 < eps 时忽略；返回新数组（忽略时返回原数组） */
export function addCut(cuts: number[], time: number, duration: number): number[] {
  if (!Number.isFinite(time) || duration <= 0) return cuts;
  const t = Math.min(Math.max(time, 0), duration);
  if (t < CUT_EPS || duration - t < CUT_EPS) return cuts;
  if (cuts.some((c) => Math.abs(c - t) < CUT_EPS)) return cuts;
  return [...cuts, t].sort((a, b) => a - b);
}

/** 提交前校验：返回不可提交的中文原因，null 表示可以提交 */
export function validateClipSelection(
  duration: number,
  cuts: number[],
  selected: ClipSpan[],
): string | null {
  if (duration <= 0 || selected.length === 0) return null;
  if (cuts.length === 0 && duration > MAX_CLIP_SECONDS) {
    return "视频超过 5 分钟，不能整段转写；请先添加切点，把片段控制在 5 分钟以内";
  }
  if (selected.some((c) => c.end - c.start > MAX_CLIP_SECONDS)) {
    return "选中的片段超过 5 分钟，请继续添加切点缩短后再提交";
  }
  return null;
}

/** 秒 → "M:SS.s"（超过 1 小时带小时位） */
export function formatTimecode(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const secStr = `${sec.toFixed(1).padStart(4, "0")}`;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${secStr}` : `${m}:${secStr}`;
}

/** 秒 → 简短时长标签，如 "12.3s" / "2m05s" */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m${String(s).padStart(2, "0")}s`;
}

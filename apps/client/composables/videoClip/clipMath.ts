export const CUT_EPS = 0.05;

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

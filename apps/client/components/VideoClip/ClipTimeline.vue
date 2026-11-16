<template>
  <div
    class="clip-timeline overflow-hidden rounded-xl border border-violet-500/20 bg-[#12101d] text-gray-200 shadow-lg"
  >
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/5 px-4 py-2.5">
      <span class="text-sm font-semibold tracking-wide text-violet-300">时间轴</span>
      <span class="font-mono text-xs text-cyan-300">{{ formatTimecode(playhead) }}</span>
      <span class="text-xs opacity-50">/ {{ formatTimecode(duration) }}</span>
      <div class="ml-auto flex items-center gap-2 text-xs opacity-80">
        <UIcon
          name="i-ph-magnifying-glass-minus"
          class="h-4 w-4"
        />
        <input
          v-model.number="pxPerSec"
          type="range"
          min="5"
          max="200"
          step="1"
          class="zoom-slider w-32"
          aria-label="时间轴缩放"
        />
        <UIcon
          name="i-ph-magnifying-glass-plus"
          class="h-4 w-4"
        />
      </div>
    </div>

    <div
      ref="scroller"
      class="timeline-scroll overflow-x-auto"
    >
      <div
        class="relative select-none"
        :style="{ width: `${contentWidth}px`, minWidth: '100%' }"
      >
        <!-- 刻度尺：点击定位播放头 -->
        <div
          class="relative h-7 cursor-pointer border-b border-white/10"
          @click="handleSeekClick"
        >
          <div
            v-for="tick in ticks"
            :key="tick"
            class="absolute top-0 h-full border-l border-white/15 pl-1 pt-0.5 font-mono text-[10px] text-gray-400"
            :style="{ left: `${tick * pxPerSec}px` }"
          >
            {{ formatTimecode(tick) }}
          </div>
        </div>

        <!-- clip 区间条 -->
        <div class="relative h-24 py-3">
          <div
            v-for="clip in clips"
            :key="clip.index"
            class="absolute bottom-3 top-3 overflow-hidden rounded-lg border transition-colors duration-150"
            :class="[
              clip.selected
                ? 'border-violet-400/60 bg-gradient-to-br from-violet-600/70 to-fuchsia-600/50 shadow-[0_0_14px_rgba(139,92,246,0.25)]'
                : 'border-white/10 bg-white/5 opacity-60',
              isOversized(clip) ? 'border-red-500/80 ring-1 ring-red-500/50' : '',
            ]"
            :style="{
              left: `${clip.start * pxPerSec + 1}px`,
              width: `${Math.max((clip.end - clip.start) * pxPerSec - 2, 8)}px`,
            }"
          >
            <div class="flex h-full flex-col justify-between px-2 py-1.5">
              <label
                class="flex cursor-pointer items-center gap-1.5 text-xs font-medium"
                :title="`Clip ${clip.index + 1} · ${formatTimecode(clip.start)} – ${formatTimecode(clip.end)}`"
              >
                <input
                  type="checkbox"
                  class="clip-checkbox"
                  :checked="clip.selected"
                  @change="emit('toggle-clip', clip.index)"
                />
                <span class="whitespace-nowrap">Clip {{ clip.index + 1 }}</span>
              </label>
              <div class="flex items-center justify-between gap-1">
                <span
                  class="whitespace-nowrap font-mono text-[10px]"
                  :class="isOversized(clip) ? 'font-semibold text-red-400' : 'opacity-75'"
                >
                  {{ formatDuration(clip.end - clip.start)
                  }}{{ isOversized(clip) ? " ·超5min" : "" }}
                </span>
                <button
                  class="rounded bg-black/30 px-1.5 py-0.5 text-[10px] hover:bg-black/50"
                  :class="previewingIndex === clip.index ? 'text-cyan-300' : 'text-gray-200'"
                  :title="previewingIndex === clip.index ? '停止预览' : '预览此片段'"
                  @click.stop="emit('preview', clip.index)"
                >
                  {{ previewingIndex === clip.index ? "■ 停止" : "▶ 预览" }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 切点标记 -->
        <div
          v-for="cut in cuts"
          :key="cut"
          class="group absolute bottom-0 top-0 z-10 w-0"
          :style="{ left: `${cut * pxPerSec}px` }"
        >
          <div class="absolute -left-px bottom-0 top-0 w-0.5 bg-amber-400/90" />
          <button
            class="absolute -left-2.5 top-0 flex h-5 w-5 items-center justify-center rounded-b bg-amber-400 text-[10px] font-bold text-black opacity-80 transition-opacity hover:opacity-100"
            title="删除切点"
            @click.stop="emit('remove-cut', cut)"
          >
            ×
          </button>
        </div>

        <!-- 播放头 -->
        <div
          class="pointer-events-none absolute bottom-0 top-0 z-20"
          :style="{ left: `${playhead * pxPerSec}px` }"
        >
          <div
            class="absolute -left-px bottom-0 top-0 w-0.5 bg-cyan-300 shadow-[0_0_8px_rgba(103,232,249,0.8)]"
          />
          <div
            class="absolute -left-[5px] top-0 h-0 w-0 border-x-[5px] border-t-[7px] border-x-transparent border-t-cyan-300"
          />
        </div>
      </div>
    </div>

    <p class="border-t border-white/5 px-4 py-2 text-[11px] text-gray-500">
      点击刻度尺定位播放头，再用「添加切点」分割视频；勾选的片段才会被转写。
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";

import type { EditorClip } from "~/composables/videoClip/useClipEditor";
import { formatDuration, formatTimecode, MAX_CLIP_SECONDS } from "~/composables/videoClip/clipMath";

const props = defineProps<{
  duration: number;
  cuts: number[];
  clips: EditorClip[];
  playhead: number;
  previewingIndex: number | null;
  isPlaying: boolean;
}>();

const emit = defineEmits<{
  (e: "seek", time: number): void;
  (e: "remove-cut", cut: number): void;
  (e: "toggle-clip", index: number): void;
  (e: "preview", index: number): void;
}>();

const pxPerSec = ref(40);
const scroller = ref<HTMLElement | null>(null);

const contentWidth = computed(() => Math.max(props.duration * pxPerSec.value + 24, 200));

const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
const ticks = computed(() => {
  const step = TICK_STEPS.find((s) => s * pxPerSec.value >= 70) ?? 1800;
  const out: number[] = [];
  for (let t = 0; t <= props.duration; t += step) out.push(t);
  return out;
});

function handleSeekClick(event: MouseEvent) {
  const target = event.currentTarget as HTMLElement;
  const rect = target.getBoundingClientRect();
  emit("seek", (event.clientX - rect.left) / pxPerSec.value);
}

function isOversized(clip: { start: number; end: number }): boolean {
  return clip.end - clip.start > MAX_CLIP_SECONDS;
}

// 播放时让播放头保持在可视范围内
watch(
  () => props.playhead,
  (t) => {
    if (!props.isPlaying || !scroller.value) return;
    const el = scroller.value;
    const x = t * pxPerSec.value;
    if (x < el.scrollLeft + 40 || x > el.scrollLeft + el.clientWidth - 60) {
      el.scrollLeft = Math.max(0, x - el.clientWidth / 2);
    }
  },
);
</script>

<style scoped>
.timeline-scroll {
  scrollbar-width: thin;
  scrollbar-color: rgba(139, 92, 246, 0.6) rgba(255, 255, 255, 0.06);
}
.timeline-scroll::-webkit-scrollbar {
  height: 10px;
}
.timeline-scroll::-webkit-scrollbar-track {
  background: rgba(255, 255, 255, 0.06);
}
.timeline-scroll::-webkit-scrollbar-thumb {
  background: rgba(139, 92, 246, 0.6);
  border-radius: 5px;
}
.timeline-scroll::-webkit-scrollbar-thumb:hover {
  background: rgba(167, 139, 250, 0.9);
}
.zoom-slider {
  accent-color: #a78bfa;
}
.clip-checkbox {
  accent-color: #22d3ee;
}
</style>

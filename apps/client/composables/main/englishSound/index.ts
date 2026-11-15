import { watchEffect } from "vue";

import type { PlayOptions } from "./audio";
import { useToolbar } from "~/composables/main/dictation";
import { useGamePlayMode } from "~/composables/user/gamePlayMode";
import { usePronunciation } from "~/composables/user/pronunciation";
import { useCourseStore } from "~/store/course";
import { play, updateSource } from "./audio";
import { playRange, setVideoSource } from "./video";

const { getPronunciationUrl, resolveAudioUrl } = usePronunciation();

export interface StatementSoundSource {
  english?: string;
  startTime?: number | null;
  endTime?: number | null;
}

/**
 * 句级发音地址：回退服务端 TTS（原声切片能力已移除，播放走视频 seek 或 TTS）。
 * 碎片单词点击播放不走这里，见 usePlayWordSound。
 */
export function getStatementSoundUrl(statement: StatementSoundSource | undefined): string {
  if (!statement) {
    return "";
  }
  return getPronunciationUrl(statement.english);
}

/** statement 是否可通过课程包配套视频 seek 播放 */
export function hasVideoTiming(
  video: string | undefined,
  statement: StatementSoundSource | undefined,
): boolean {
  return Boolean(video && statement && statement.startTime != null && statement.endTime != null);
}

/**
 * 视频同步播放：课程包带视频且 statement 有时间戳时 seek 播放区间。
 * 返回 stop 函数；不满足条件（或视频未就绪）返回 null，由调用方回退音频/TTS。
 */
function playStatementVideo(
  video: string | undefined,
  statement: StatementSoundSource | undefined,
  options?: PlayOptions,
): (() => void) | null {
  if (!hasVideoTiming(video, statement)) {
    return null;
  }
  setVideoSource(resolveAudioUrl(video));
  return playRange(statement!.startTime!, statement!.endTime!, options);
}

let lastPronunciationUrl = "";
export function useCurrentStatementEnglishSound() {
  const courseStore = useCourseStore();
  const { toolBarData } = useToolbar();
  const { isDictationMode } = useGamePlayMode();

  watchEffect(() => {
    const pack = courseStore.currentLearning;
    if (pack?.video) {
      setVideoSource(resolveAudioUrl(pack.video));
    }
    // 走视频同步的句子不需要预载音频源（避免无谓的 TTS 请求）
    if (hasVideoTiming(pack?.video, courseStore.currentStatement)) {
      return;
    }
    const pronunciationUrl = getStatementSoundUrl(courseStore.currentStatement);
    if (lastPronunciationUrl !== pronunciationUrl) {
      updateSource(pronunciationUrl);
    }
    lastPronunciationUrl = pronunciationUrl;
  });

  return {
    playSound: (options?: PlayOptions) => {
      const playOptions = isDictationMode()
        ? (({ times, rate, interval }) => ({ times, rate, interval }))(toolBarData)
        : options;
      const stopVideo = playStatementVideo(
        courseStore.currentLearning?.video,
        courseStore.currentStatement,
        playOptions,
      );
      if (stopVideo) {
        return stopVideo;
      }
      return play(playOptions);
    },
  };
}

// 朗读每日一句
export function readOneSentencePerDayAloud(str: string) {
  const pronunciationUrl = getPronunciationUrl(str);
  updateSource(pronunciationUrl);
  play();
}

export function playEnglish(statement: string | StatementSoundSource) {
  if (typeof statement !== "string") {
    const stopVideo = playStatementVideo(useCourseStore().currentLearning?.video, statement);
    if (stopVideo) {
      return;
    }
  }
  const pronunciationUrl =
    typeof statement === "string"
      ? getPronunciationUrl(statement)
      : getStatementSoundUrl(statement);
  updateSource(pronunciationUrl);
  play();
}

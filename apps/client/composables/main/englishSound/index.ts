import { watchEffect } from "vue";

import type { PlayOptions } from "./audio";
import { useToolbar } from "~/composables/main/dictation";
import { useGamePlayMode } from "~/composables/user/gamePlayMode";
import { usePronunciation } from "~/composables/user/pronunciation";
import { useCourseStore } from "~/store/course";
import { play, updateSource } from "./audio";

const { getPronunciationUrl, resolveAudioUrl } = usePronunciation();

export interface StatementSoundSource {
  english?: string;
  audioUrl?: string | null;
}

/**
 * 句级发音地址：有真实音频切片（audioUrl）用原声，否则回退服务端 TTS。
 * 碎片单词点击播放不走这里（保持 TTS），见 usePlayWordSound。
 */
export function getStatementSoundUrl(statement: StatementSoundSource | undefined): string {
  if (!statement) {
    return "";
  }
  const clipUrl = resolveAudioUrl(statement.audioUrl);
  if (clipUrl) {
    return clipUrl;
  }
  return getPronunciationUrl(statement.english);
}

let lastPronunciationUrl = "";
export function useCurrentStatementEnglishSound() {
  const courseStore = useCourseStore();
  const { toolBarData } = useToolbar();
  const { isDictationMode } = useGamePlayMode();

  watchEffect(() => {
    const pronunciationUrl = getStatementSoundUrl(courseStore.currentStatement);
    if (lastPronunciationUrl !== pronunciationUrl) {
      updateSource(pronunciationUrl);
    }
    lastPronunciationUrl = pronunciationUrl;
  });

  return {
    playSound: (options?: PlayOptions) => {
      if (isDictationMode()) {
        const { times, rate, interval } = toolBarData;
        return play({ times, rate, interval });
      } else {
        return play(options);
      }
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
  const pronunciationUrl =
    typeof statement === "string"
      ? getPronunciationUrl(statement)
      : getStatementSoundUrl(statement);
  updateSource(pronunciationUrl);
  play();
}

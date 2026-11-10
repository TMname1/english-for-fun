import { usePronunciation } from "~/composables/user/pronunciation";

// 便于测试
// 后面不使用 audio 后也可以不破坏业务逻辑
const audio = new Audio();
export function updateSource(src: string) {
  if (!src) {
    // 空 URL（例如句子内容为空）：清掉旧资源，避免加载无效地址后 play() 报 NotSupportedError
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    return;
  }
  audio.src = src;
  audio.load();
}

const { getPronunciationUrl } = usePronunciation();
export function usePlayWordSound() {
  const wordAudio = new Audio();
  let lastWord = "";
  let isPlaying = false;

  wordAudio.onplay = () => {
    isPlaying = true;
  };

  wordAudio.onended = () => {
    isPlaying = false;
  };

  function handlePlayWordSound(word: string) {
    if (isPlaying && lastWord === word) {
      // skip
      return;
    }
    const src = getPronunciationUrl(word);
    if (!src) {
      return;
    }
    lastWord = word;
    wordAudio.src = src;
    wordAudio.play().catch((error) => {
      console.warn("[englishSound] word playback failed", error);
      isPlaying = false;
    });
  }

  return {
    handlePlayWordSound,
  };
}

export interface PlayOptions {
  times?: number;
  rate?: number;
  interval?: number;
}

const DefaultPlayOptions = {
  times: 1,
  rate: 1,
  interval: 500,
};

export function play(playOptions?: PlayOptions) {
  const { times, rate, interval } = Object.assign({}, DefaultPlayOptions, playOptions);

  audio.playbackRate = rate;

  let index = 1;
  let timeoutId: NodeJS.Timeout | undefined;

  function handleEnded() {
    timeoutId = setTimeout(() => {
      if (index < times) {
        playOnce();
        index++;
      } else {
        index = 1;
        audio.removeEventListener("ended", handleEnded);
      }
    }, interval);
  }

  function playOnce() {
    // 资源加载失败（服务端异常等）时 play() 会 reject，这里兜底避免 Uncaught (in promise)
    audio.play().catch((error) => {
      console.warn("[englishSound] audio playback failed", error);
      stop();
    });
  }

  if (times > 1) {
    audio.addEventListener("ended", handleEnded, false);
  }

  playOnce();

  function stop() {
    audio.pause();
    audio.currentTime = 0;
    audio.removeEventListener("ended", handleEnded);
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }

  return stop;
}

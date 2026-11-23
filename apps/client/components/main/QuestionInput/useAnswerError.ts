import { useAnswerTip } from "~/composables/main/answerTip";
import { usePlayTipSound } from "./useTypingSound";

export function useAnswerError() {
  const { playErrorSound } = usePlayTipSound();
  const { hiddenAnswerTip } = useAnswerTip();

  function handleAnswerError() {
    // 答错只播放提示音，答案必须由用户手动点击“显示答案”或快捷键触发
    playErrorSound();
  }

  function resetCloseTip() {
    hiddenAnswerTip();
  }

  return {
    handleAnswerError,
    resetCloseTip,
  };
}

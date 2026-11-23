import { ref } from "vue";

const showStatementEditModal = ref(false);

/**
 * 「修改当前句子」弹窗的显隐状态。
 * 与 useGameSetting / useCourseContents 保持一致：状态放在 composable 里，
 * 由 Tool 里的按钮打开，弹窗组件自己读写同一份 ref。
 */
export function useStatementEdit() {
  function openStatementEditModal() {
    showStatementEditModal.value = true;
  }

  function closeStatementEditModal() {
    showStatementEditModal.value = false;
  }

  return {
    showStatementEditModal,
    openStatementEditModal,
    closeStatementEditModal,
  };
}

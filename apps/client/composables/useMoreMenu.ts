import { ref } from "vue";

const isMoreMenuOpen = ref(false);

export function useMoreMenu() {
  const openMoreMenu = () => {
    isMoreMenuOpen.value = true;
  };

  const closeMoreMenu = () => {
    isMoreMenuOpen.value = false;
  };

  const toggleMoreMenu = () => {
    isMoreMenuOpen.value = !isMoreMenuOpen.value;
  };

  return {
    isMoreMenuOpen,
    openMoreMenu,
    closeMoreMenu,
    toggleMoreMenu,
  };
}

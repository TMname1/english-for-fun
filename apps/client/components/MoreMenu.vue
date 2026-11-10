<template>
  <USlideover
    v-model="isMoreMenuOpen"
    :ui="{ width: 'w-screen max-w-80' }"
  >
    <div class="flex h-full flex-col">
      <div class="flex items-center justify-between border-b p-4 dark:border-gray-700">
        <div class="text-xl font-bold">更多</div>
        <UButton
          color="gray"
          variant="ghost"
          icon="i-heroicons-x-mark-20-solid"
          @click="closeMoreMenu"
          tabindex="-1"
          :ui="{ color: { gray: { ghost: 'dark:hover:bg-gray-600' } } }"
        />
      </div>

      <div class="flex-grow p-4">
        <button
          v-for="item in menuOptions"
          :key="item.name"
          @click="item.eventName"
          class="mb-2 flex w-full items-center rounded-lg p-2 transition-all duration-200 ease-in-out hover:bg-base-200 hover:shadow-md dark:hover:bg-gray-600"
          tabindex="-1"
        >
          <UIcon
            :name="item.icon"
            class="mr-3 h-7 w-7"
          ></UIcon>
          <span class="font-medium">{{ item.title }}</span>
        </button>
      </div>

      <div class="p-4 text-center text-xs opacity-50">版本 v1.0.0</div>
    </div>
  </USlideover>
</template>

<script setup lang="ts">
import { navigateTo } from "#imports";
import { useRuntimeConfig } from "nuxt/app";
import { computed } from "vue";

import { Theme, useDarkMode } from "~/composables/darkMode";
import { useMoreMenu } from "~/composables/useMoreMenu";

const { isMoreMenuOpen, closeMoreMenu } = useMoreMenu();
const { darkMode, toggleDarkMode } = useDarkMode();
const runtimeConfig = useRuntimeConfig();
const isDarkMode = computed(() => darkMode.value === Theme.DARK);

const menuOptions = computed(() => {
  return [
    {
      title: "掌握列表",
      name: "masteredElements",
      eventName: handleMasteredElements,
      icon: "i-ph-book",
    },
    {
      title: "编辑器",
      name: "editor",
      eventName: handleGoToEditor,
      icon: "i-ph-planet-duotone",
    },
    {
      title: "帮助文档",
      name: "helpDocs",
      eventName: handleHelpDocs,
      icon: "i-ph-book-open-text-duotone",
    },
    {
      title: "建议反馈",
      name: "feedback",
      eventName: handleFeedback,
      icon: "i-ph-hands-praying-duotone",
    },
    {
      title: "主题切换",
      name: "changeTheme",
      eventName: toggleDarkMode,
      icon: isDarkMode.value ? "i-ph-moon" : "i-ph-sun",
    },
  ];
});

function handleHelpDocs() {
  closeMoreMenu();
  window.open(runtimeConfig.public.helpDocsURL, "_blank");
}

function handleFeedback() {
  closeMoreMenu();
  window.open("https://txc.qq.com/products/652508", "_blank");
}

function handleMasteredElements() {
  closeMoreMenu();
  navigateTo("/mastered-elements");
}

function handleGoToEditor() {
  closeMoreMenu();
  window.open("https://earthworm-editor.cuixueshe.com", "_blank");
}
</script>

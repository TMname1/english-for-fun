<template>
  <header
    class="w-full px-5 font-customFont transition-all duration-300 ease-linear"
    :class="{
      'sticky top-0 z-10': isStickyNavBar,
      'glass bg-gradient-to-r from-transparent via-white/10 to-transparent shadow-md':
        isStickyNavBar && isScrolled,
    }"
  >
    <div class="mx-auto max-w-screen-xl">
      <div class="flex h-16 items-center justify-between">
        <NuxtLink to="/">
          <div class="logo flex items-center">
            <img
              width="48"
              height="48"
              class="mr-6 hidden overflow-hidden rounded-md md:block"
              src="/logo.png"
              alt="earth-worm-logo"
            />
            <h1 class="text-wrap text-2xl font-extrabold leading-normal dark:text-white">
              Earthworm
            </h1>
          </div>
        </NuxtLink>

        <nav class="flex items-center gap-1 sm:gap-2">
          <button
            aria-label="管理课程"
            class="btn btn-ghost btn-sm gap-1.5 text-base"
            @click="handleGoToCoursePackManage"
          >
            <UIcon
              name="i-ph-toolbox"
              class="h-6 w-6"
            />
            <span class="hidden sm:inline">管理课程</span>
          </button>

          <button
            aria-label="帮助文档"
            class="btn btn-ghost btn-sm gap-1.5 text-base"
            @click="handleHelpDocs"
          >
            <UIcon
              name="i-ph-book-open-text-duotone"
              class="h-6 w-6"
            />
            <span class="hidden sm:inline">帮助文档</span>
          </button>

          <button
            aria-label="主题切换"
            class="btn btn-ghost btn-sm gap-1.5 text-base"
            @click="toggleDarkMode"
          >
            <UIcon
              :name="isDarkMode ? 'i-ph-moon' : 'i-ph-sun'"
              class="h-6 w-6"
            />
            <span class="hidden sm:inline">{{ isDarkMode ? "深色" : "浅色" }}</span>
          </button>

          <button
            v-if="allowForge"
            aria-label="导入视频"
            class="btn btn-ghost btn-sm gap-1.5 text-base"
            @click="showForgeModal = true"
          >
            <UIcon
              name="i-ph-upload-simple"
              class="h-6 w-6"
            />
            <span class="hidden sm:inline">导入视频</span>
          </button>
        </nav>
      </div>
    </div>
    <ForgeImportModal
      v-if="allowForge"
      v-model:show="showForgeModal"
      @confirmed="handleForgeConfirmed"
    />
  </header>
</template>

<script setup lang="ts">
import { useWindowScroll } from "@vueuse/core";
import { navigateTo, useRuntimeConfig } from "#imports";
import { computed, ref } from "vue";
import { useRoute } from "vue-router";

import ForgeImportModal from "~/components/ForgeImport/ForgeImportModal.vue";
import { Theme, useDarkMode } from "~/composables/darkMode";

const route = useRoute();
const { y } = useWindowScroll();
const { darkMode, toggleDarkMode } = useDarkMode();
const runtimeConfig = useRuntimeConfig();

const isDarkMode = computed(() => darkMode.value === Theme.DARK);

const SCROLL_THRESHOLD = 8;

const isStickyNavBar = computed(() =>
  ["index", "mastered-elements"].includes(route.name as string),
);
const isScrolled = computed(() => y.value >= SCROLL_THRESHOLD);

const allowForge = computed(() => runtimeConfig.public.allowForge !== false);
const showForgeModal = ref(false);

function handleGoToCoursePackManage() {
  navigateTo("/course-pack/manage");
}

function handleHelpDocs() {
  window.open(runtimeConfig.public.helpDocsURL, "_blank");
}

function handleForgeConfirmed(coursePackId: string) {
  navigateTo(`/game/${coursePackId}`);
}
</script>

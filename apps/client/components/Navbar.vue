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
              alt="EnglishForFun logo"
            />
            <h1 class="text-wrap text-2xl font-extrabold leading-normal dark:text-white">
              EnglishForFun
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
            v-if="allowForge"
            aria-label="导入视频"
            class="btn btn-ghost btn-sm gap-1.5 text-base"
            @click="navigateTo('/video-clip')"
          >
            <UIcon
              name="i-ph-upload-simple"
              class="h-6 w-6"
            />
            <span class="hidden sm:inline">导入视频</span>
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

          <div
            class="ml-1 flex items-center gap-2 border-l border-gray-200 pl-2 dark:border-gray-700 sm:ml-2 sm:pl-3"
          >
            <img
              src="/avatar.png"
              alt="用户头像"
              class="h-8 w-8 rounded-full object-cover"
            />
            <span class="hidden text-sm font-medium sm:inline">{{ authUser?.username }}</span>
            <button
              aria-label="退出登录"
              class="btn btn-ghost btn-sm"
              @click="handleLogout"
            >
              <UIcon
                name="i-ph-sign-out"
                class="h-5 w-5"
              />
            </button>
          </div>
        </nav>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { useWindowScroll } from "@vueuse/core";
import { navigateTo, useRuntimeConfig, useState } from "#imports";
import { computed } from "vue";
import { useRoute } from "vue-router";

import type { AuthUser } from "~/api/auth";
import { logout } from "~/api/auth";
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

function handleGoToCoursePackManage() {
  navigateTo("/course-pack/manage");
}

const authUser = useState<AuthUser | null>("authUser", () => null);

async function handleLogout() {
  try {
    await logout();
  } finally {
    authUser.value = null;
    navigateTo("/login");
  }
}
</script>

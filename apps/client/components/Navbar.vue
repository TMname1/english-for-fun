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

        <button
          aria-label="更多"
          class="btn btn-ghost btn-sm gap-2 text-base"
          @click="openMoreMenu"
        >
          <UIcon
            name="i-ph-dots-three-circle"
            class="h-6 w-6"
          />
          <span class="hidden sm:inline">更多</span>
        </button>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { useWindowScroll } from "@vueuse/core";
import { computed } from "vue";
import { useRoute } from "vue-router";

import { useMoreMenu } from "~/composables/useMoreMenu";

const { openMoreMenu } = useMoreMenu();
const route = useRoute();
const { y } = useWindowScroll();

const SCROLL_THRESHOLD = 8;

// TODO: 设置需要固定导航栏的页面
const isStickyNavBar = computed(() =>
  ["index", "mastered-elements"].includes(route.name as string),
);
const isScrolled = computed(() => y.value >= SCROLL_THRESHOLD);
</script>

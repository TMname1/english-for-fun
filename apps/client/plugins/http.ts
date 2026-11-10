import { useRuntimeConfig } from "#app";
import { defineNuxtPlugin } from "nuxt/app";

import { setupHttp } from "../api/http";
import { setupPronunciation } from "../composables/user/pronunciation";

export default defineNuxtPlugin(() => {
  setupHttp();
  const config = useRuntimeConfig();
  setupPronunciation({ apiBase: config.public.apiBase as string });
});

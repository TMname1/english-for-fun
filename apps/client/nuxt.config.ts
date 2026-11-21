// https://nuxt.com/docs/api/configuration/nuxt-config

const appScripts: any = [];
if (process.env.NODE_ENV === "production") {
  addClarity();
}

// for https://clarity.microsoft.com/
function addClarity() {
  appScripts.push({
    innerHTML: `(function(c,l,a,r,i,t,y){
        c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
        t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
        y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
    })(window, document, "clarity", "script", "${process.env.CLARITY}");`,
  });
}

export default defineNuxtConfig({
  ssr: false,
  // default is true, reference to https://nuxt.com/docs/guide/directory-structure/components
  // components: true,
  imports: {
    autoImport: false,
  },
  devtools: {
    enabled: true,
  },
  app: {
    head: {
      title: "EnglishForFun",
      link: [{ rel: "icon", href: "/favicon.ico" }],
      script: appScripts,
    },
  },
  css: ["~/assets/css/globals.css"],
  ui: {
    // gray 被 Nuxt UI 默认排除在 safelist 外，导致 color="gray" 按钮的
    // dark:bg-gray-950 等深色类不会被生成（深色模式下按钮仍是白底）
    safelistColors: ["primary", "gray"],
  },
  modules: [
    "@nuxt/ui",
    "@vueuse/nuxt",
    "@nuxt/test-utils/module",
    "@hypernym/nuxt-anime",
    "@nuxt/image",
  ],
  plugins: ["~/plugins/http.ts"],
  runtimeConfig: {
    public: {
      apiBase: process.env.API_BASE || "",
      // 仅本地 dev 暴露"导入视频"按钮；生产 .env.prod 设 ALLOW_FORGE=0 关闭
      allowForge: process.env.ALLOW_FORGE !== "0",
    },
  },
  build: {
    transpile: ["vue-sonner"],
  },
});

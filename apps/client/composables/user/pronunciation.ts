import { ref } from "vue";

/**
 * 服务端 TTS 发音接口（Edge 神经网络语音，见 apps/api/src/tts）
 *
 * GET ${apiBase}/tts?accent=American|British&text=<encoded text>
 */

export enum PronunciationType {
  American = "American",
  British = "British",
}

export const pronunciationLabels: { [key in PronunciationType]: string } = {
  [PronunciationType.American]: "美音",
  [PronunciationType.British]: "英音",
};

const PRONUNCIATION_TYPE = "pronunciationType";
const pronunciation = ref<PronunciationType>(PronunciationType.American); // 默认美音

let apiBase = "";

/**
 * 在应用启动时（plugins/http.ts）注入 API 基础地址，
 * 避免在模块顶层调用 useRuntimeConfig 拿不到 Nuxt 上下文
 */
export function setupPronunciation(options: { apiBase: string }) {
  apiBase = options.apiBase;
}

export function usePronunciation() {
  loadCache();

  function loadCache() {
    const type = getStore() || pronunciation.value;
    setStore(type);
  }

  function setStore(value: PronunciationType) {
    pronunciation.value = value;
    localStorage.setItem(PRONUNCIATION_TYPE, value);
  }

  function getStore(): PronunciationType {
    return localStorage.getItem(PRONUNCIATION_TYPE) as PronunciationType;
  }

  function getPronunciationOptions() {
    return Object.entries(pronunciationLabels).map(([key, value]) => {
      return {
        label: value,
        value: key,
      };
    });
  }

  function getPronunciationUrl(english: string | undefined): string {
    const text = english?.trim();
    if (!text) {
      return "";
    }
    return `${apiBase}/tts?accent=${pronunciation.value}&text=${encodeURIComponent(text)}`;
  }

  // 切换发音
  function togglePronunciation(type: PronunciationType) {
    if (type !== pronunciation.value) setStore(type);
  }

  return {
    pronunciation,
    getPronunciationOptions,
    getPronunciationUrl,
    togglePronunciation,
  };
}

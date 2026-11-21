import type { $Fetch } from "ofetch";

import { navigateTo, useRuntimeConfig } from "#app";
import { ofetch } from "ofetch";

let http: $Fetch;
export function setupHttp() {
  if (http) return http;

  const config = useRuntimeConfig();
  const baseURL = config.public.apiBase as string;

  http = ofetch.create({
    baseURL,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    async onResponseError({ request, response, options }) {
      // 登录页自身的 401（密码错误）只提示，不跳转
      if (response.status === 401 && window.location.pathname !== "/login") {
        navigateTo("/login");
      }
      const { message } = response._data;
      if (Array.isArray(message)) {
        message.forEach((item) => {
          httpStatusErrorHandler?.(item, response.status);
        });
      } else {
        httpStatusErrorHandler?.(message, response.status);
      }
      return Promise.reject(response._data);
    },
    retry: 3,
    retryDelay: 1000,
  });
}

type HttpStatusErrorHandler = (message: string, statusCode: number) => void;
let httpStatusErrorHandler: HttpStatusErrorHandler;

export function injectHttpStatusErrorHandler(handler: HttpStatusErrorHandler) {
  httpStatusErrorHandler = handler;
}

export function getHttp() {
  if (!http) {
    throw new Error("HTTP client not initialized. Call setupHttp first.");
  }
  return http;
}

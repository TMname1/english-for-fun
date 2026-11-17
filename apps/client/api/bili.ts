import type { $Fetch } from "ofetch";

import { useRuntimeConfig } from "#imports";
import { ofetch } from "ofetch";

export interface BiliLoginStatus {
  isLogin: boolean;
  hasCookie: boolean;
  uname?: string;
  vipStatus?: boolean;
}

export interface BiliLoginStart {
  key: string;
  qrDataUrl: string;
}

export type BiliLoginPollStatus = "pending" | "scanned" | "expired" | "success";
export interface BiliLoginPoll {
  status: BiliLoginPollStatus;
  uname?: string;
  vipStatus?: boolean;
}

export interface BiliPage {
  page: number;
  part: string;
  duration: number;
}
export interface BiliInfo {
  bvid: string;
  title: string;
  pages: BiliPage[];
}

export interface BiliDownloadParams {
  url: string;
  title: string;
  type: "dialogue" | "music";
  p?: number;
  qn?: string;
  noCookie?: boolean;
  language?: string;
  desc?: string;
}

export type BiliDownloadStatus = "running" | "done" | "failed" | "cancelled";
export interface BiliDownloadView {
  id: string;
  status: BiliDownloadStatus;
  phase: string;
  downloaded: number;
  total: number;
  percent: number;
  jobId?: string;
  videoPath?: string;
  error?: string;
}

function biliFetch(): $Fetch {
  const config = useRuntimeConfig();
  return ofetch.create({ baseURL: config.public.apiBase as string, credentials: "include" });
}

export async function getBiliLoginStatus(): Promise<BiliLoginStatus> {
  const $fetch = biliFetch();
  return $fetch<BiliLoginStatus>("/bili/login/status", { method: "get", retry: 0 });
}

export async function startBiliLogin(): Promise<BiliLoginStart> {
  const $fetch = biliFetch();
  return $fetch<BiliLoginStart>("/bili/login/start", { method: "post", retry: 0 });
}

export async function pollBiliLogin(key: string): Promise<BiliLoginPoll> {
  const $fetch = biliFetch();
  return $fetch<BiliLoginPoll>("/bili/login/poll", { method: "get", query: { key }, retry: 0 });
}

export async function getBiliInfo(url: string): Promise<BiliInfo> {
  const $fetch = biliFetch();
  return $fetch<BiliInfo>("/bili/info", { method: "get", query: { url }, retry: 0 });
}

export async function startBiliDownload(
  params: BiliDownloadParams,
): Promise<{ downloadId: string }> {
  const $fetch = biliFetch();
  return $fetch<{ downloadId: string }>("/bili/downloads", {
    method: "post",
    body: params,
    retry: 0,
  });
}

export async function fetchBiliDownload(id: string): Promise<BiliDownloadView> {
  const $fetch = biliFetch();
  return $fetch<BiliDownloadView>(`/bili/downloads/${id}`, { method: "get", retry: 0 });
}

export async function cancelBiliDownload(id: string): Promise<{ cancelled: boolean }> {
  const $fetch = biliFetch();
  return $fetch<{ cancelled: boolean }>(`/bili/downloads/${id}/cancel`, {
    method: "post",
    retry: 0,
  });
}

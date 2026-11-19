import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO_ROOT } from "../forge/runner-client";

/**
 * 动态加载 packages/bilidown 的 ESM 内核。
 * nest build 产物是 commonjs，静态 import 会被 tsc 转成 require 而无法加载 type:module 的 ESM；
 * 这里用运行时真·动态 import（new Function 绕过 tsc 的 import() → require 降级）。
 */
const CORE_URL = pathToFileURL(join(REPO_ROOT, "packages", "bilidown", "src", "core.js")).href;
const dynamicImport = new Function("s", "return import(s)") as unknown as (
  s: string,
) => Promise<BilidownCore>;

export interface BiliLoginStatus {
  isLogin: boolean;
  hasCookie: boolean;
  uname?: string;
  vipStatus?: boolean;
}
export interface BiliQrcode {
  url: string;
  qrcodeKey: string;
  jar: Record<string, string>;
}
export interface BiliPollResult {
  status: string;
  uname?: string;
  vipStatus?: boolean;
  message?: string;
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
export interface BiliProgress {
  stream: string;
  downloaded: number;
  total: number;
}
export interface BiliDownloadResult {
  filePath: string;
  fileName: string;
  title: string;
  page: number;
  bvid: string;
}
export interface BiliDownloadOptions {
  input: string;
  p?: number;
  qn?: string;
  noCookie?: boolean;
  outDir: string;
  outName?: string;
  keep?: boolean;
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
  onProgress?: (progress: BiliProgress) => void;
  onLog?: (message: string, level?: string) => void;
}

/** 内核可注入的异步 cookie 存储：服务端用数据库实现并加载入。 */
export interface CookieStore {
  load(): Promise<Record<string, string>>;
  save(jar: Record<string, string>): Promise<void>;
}

export interface BilidownCore {
  configureCookieStore(store: CookieStore): void;
  getLoginStatus(): Promise<BiliLoginStatus>;
  createLoginQrcode(): Promise<BiliQrcode>;
  pollLogin(qrcodeKey: string, jar: Record<string, string>): Promise<BiliPollResult>;
  getInfo(input: string): Promise<BiliInfo>;
  download(opts: BiliDownloadOptions): Promise<BiliDownloadResult>;
  parseBvid(input: string): string;
}

let corePromise: Promise<BilidownCore> | null = null;

export function getBilidownCore(): Promise<BilidownCore> {
  if (!corePromise) corePromise = dynamicImport(CORE_URL);
  return corePromise;
}

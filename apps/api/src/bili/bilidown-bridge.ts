import * as core from "./bilidown/core";

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

export function getBilidownCore(): Promise<BilidownCore> {
  return Promise.resolve(core as unknown as BilidownCore);
}

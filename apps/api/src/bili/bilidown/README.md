# bilidown（B 站下载内核）

对 **BiliDown v1.2.7**（一款 Electron 版 B 站视频下载器）的**最小 Node 复刻**。
仅还原其核心功能：**核心下载链路** 与 **扫码登录 + Cookie**。

已合并进 `apps/api`（本目录），由 `bilidown-bridge.ts` 静态 import 复用（扫码登录 + 后台下载，下载完成后自动创建 forge 课程制作任务）。独立 CLI 已随合并移除，登录走服务端扫码接口（`/bili/login/*`），cookie 持久化到 `bili_cookie` 表。

> 逆向来源：解包 `resources/app.asar`，主进程 `background.js`、渲染层 `assets/js/app.*.js`。

## 原项目实现思路（被还原的部分）

1. **薄主进程 + 厚渲染层**：Electron 窗口开了 `nodeIntegration:true / contextIsolation:false / webSecurity:false`，所以业务逻辑（HTTP、调 ffmpeg）全在渲染层，可直接用 Node。
2. **破防盗链**：主进程 `onBeforeSendHeaders` 给命中 `bilibili/bilivideo` 的请求统一注入 `User-Agent` 和 `Referer: https://www.bilibili.com`，否则 `*.bilivideo.com` 直链会 403。
3. **取流**：`view?bvid=` 拿分 P 的 `cid` → `playurl?...fnval=4048&fourk=1` 拿 **DASH**（音视频分离两条流）；DASH 不可用时回退 `platform=html5&otype=json` 拿单文件 `durl`。
4. **下载 + 混流**：原项目用随包的 `aria2c.exe` 多线程下音视频，再用 `ffmpeg.exe` 无损混流 `-i v -i a -acodec copy -vcodec copy -f mp4`，音频转 mp3 用 `-q:a 0 -map a`。
5. **登录**：`passport-login/web/qrcode/generate|poll` 扫码登录，存 `SESSDATA` 等 cookie；`nav` 查登录/大会员状态（高清/4K 需登录）。
6. **作者后端 / 自动更新 / 弹幕字幕**：分别用 `bili.zhouql.vip` 做统计、electron-builder 做自动更新、`dm/list.so` 做弹幕——**本次按约定不实现**。

## 与原实现的差异（有意为之）

- 形态：从 Electron GUI 改成 **Node CLI**（按你的选择）。
- 下载：用 **Node `fetch` 流式 + Range 断点续传** 替代 `aria2c` 多线程，少一个外部依赖，行为等价。
- 取流：补上了 **WBI 签名**（`w_rid/wts`）。原 1.2.7 走的是免签名老参数，今天的 `playurl` 已普遍要求签名，不加会失败。
- ffmpeg：默认用 `ffmpeg-static` 随包二进制（`pnpm install` 自动下载），缺失时退回 PATH 中的 `ffmpeg`，也可用 `--ffmpeg` 显式指定。

## 环境要求

- Node.js **>= 18**（用到全局 `fetch` / `Readable.fromWeb`）
- ffmpeg：默认走 `ffmpeg-static` 随包二进制；也可用系统 PATH 里的 `ffmpeg` 或 `--ffmpeg` 指定

## 使用（服务端）

入口是 `core.js`，经 `apps/api/src/bili/bilidown-bridge.ts` 的 `getBilidownCore()` 暴露给 `bili` 模块：

- `configureCookieStore(store)`：注入异步 cookie 存储（服务端用 `bili-cookie.store.ts` 的数据库实现）
- `createLoginQrcode()` / `pollLogin()`：扫码登录
- `getInfo(input)` / `download(opts)`：解析与下载（opts 见下方参数参考）

## 下载参数参考（BiliDownloadOptions）

> 原 CLI 已移除，下表字段与 `core.js` 的 download opts 一一对应（p/qn/outDir/keep 等）。

### 下载选项

| 选项            | 取值                | 默认                                                    | 说明                                                                                                                                      |
| --------------- | ------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `--p <n>`       | 正整数              | `1`                                                     | 分 P 序号。`n` 从 1 开始；越界时回退到第一个 P。                                                                                          |
| `--qn <x>`      | 清晰度别名或数字 id | 最高（`8k` / id 127）                                   | 请求画质**上限**：实际选取「id 不超过该值的最高流」；若超出账号权限会自动降级。别名见下方对照表，也可直接传 B 站数字 id（如 `--qn 80`）。 |
| `--audio`       | 开关（无值）        | 关                                                      | 只下载音频流并用 ffmpeg 转成 `.mp3`，不合成视频。                                                                                         |
| `--out <dir>`   | 目录路径            | `./downloads`                                           | 输出目录，不存在时自动创建。                                                                                                              |
| `--ffmpeg <p>`  | 可执行文件路径      | `ffmpeg-static` 随包二进制，缺失时在 PATH 中找 `ffmpeg` | 显式指定 ffmpeg 路径。                                                                                                                    |
| `--keep`        | 开关（无值）        | 关                                                      | 保留 `<out>/.tmp` 下的音视频中间文件（`*.v.m4s` / `*.a.m4s`）；默认混流完成后删除。                                                       |
| `-h` / `--help` | 开关（无值）        | —                                                       | 打印内置帮助文本。                                                                                                                        |

> 服务端下载自动携带 `bili_cookie` 表中的 cookie：已登录即带 cookie（解锁高清/大会员），未登录则不带（仅低画质）。
>
> `nav` / `view` / `playurl` 一律带访客指纹 `buvid3`（`lib/http.js` 的 `withBuvid3`，值取自 `x/frontend/finger/spi` 并进程内缓存）：服务器所在机房 IP 不带它会被 B 站风控成 HTTP 412，家宽 IP 则不会，所以只在云端复现。

### `--qn` 清晰度对照表

| 别名      | 流 id | 含义       | 通常需要      |
| --------- | ----- | ---------- | ------------- |
| `360`     | 16    | 流畅       | —             |
| `480`     | 32    | 清晰       | —             |
| `720`     | 64    | 高清       | 免登录即可    |
| `1080`    | 80    | 1080P      | 登录          |
| `1080p60` | 116   | 1080P 60帧 | 登录 / 大会员 |
| `4k`      | 120   | 4K 超清    | 大会员        |
| `8k`      | 127   | 8K 超清    | 大会员        |

不写 `--qn` 时默认按最高画质（id 127）请求，再根据账号权限与可用流自动选到能拿到的最高一档。

## 目录结构

```
bilidown/
  core.js           内核入口，串联整条链路
  api/
    bili.js         nav / view / playurl(DASH) / html5 回退 / 选流
    login.js        二维码生成 + 轮询登录
  lib/
    http.js         UA/Referer 注入（破防盗链）
    wbi.js          WBI 签名（img_key+sub_key → w_rid）
    storage.js      cookie 串与 jar 的纯转换（持久化由调用方注入）
    download.js     流式下载 + 断点续传
    ffmpeg.js       混流 mp4 / 转 mp3
```

B 站登录为服务端扫码：cookie 持久化到数据库 `bili_cookie` 表（`bili-cookie.store.ts` 实现 CookieStore 注入内核）。

## 合规提示

仅用于个人学习/备份自己有权下载的内容，遵守 B 站用户协议与版权规定。

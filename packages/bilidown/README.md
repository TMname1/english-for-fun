# @earthworm/bilidown

对 **BiliDown v1.2.7**（一款 Electron 版 B 站视频下载器）的**最小 Node CLI 复刻**。
仅还原其核心功能：**核心下载链路** 与 **扫码登录 + Cookie**。

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
- ffmpeg：不再随包，依赖系统 `ffmpeg`（或用 `--ffmpeg` 指定路径）。

## 环境要求

- Node.js **>= 18**（用到全局 `fetch` / `Readable.fromWeb`）
- 系统 PATH 里有 `ffmpeg`，或用 `--ffmpeg` 指定

## 安装

```bash
cd /d/bilidown-REA
npm install
```

## 使用

```bash
# 1) 扫码登录（终端出二维码，用 B 站 App 扫）
node src/index.js login

# 2) 下载（默认最高画质，输出到 ./downloads）
node src/index.js BV1xx411c7mD
node src/index.js https://www.bilibili.com/video/BV1xx411c7mD --p 2 --qn 1080

# 只要音频，转 mp3
node src/index.js BV1xx411c7mD --audio

# 不携带 cookie（仅低画质）/ 指定 ffmpeg / 保留中间文件
node src/index.js BV1xx411c7mD --no-cookie --ffmpeg "C:/path/ffmpeg.exe" --keep
```

选项：见下方 [CLI 参数说明](#cli-参数说明)。

## CLI 参数说明

### 命令

| 命令                 | 说明                                                                          |
| -------------------- | ----------------------------------------------------------------------------- |
| `login`              | 终端出二维码，用 B 站 App 扫码登录；成功后 cookie 存到项目根 `cookies.json`。 |
| `<BV号 \| 视频链接>` | 解析并下载视频；也可直接传完整 URL，会自动提取其中的 `BV…` 号。               |

### 下载选项

| 选项            | 取值                | 默认                    | 说明                                                                                                                                      |
| --------------- | ------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `--p <n>`       | 正整数              | `1`                     | 分 P 序号。`n` 从 1 开始；越界时回退到第一个 P。                                                                                          |
| `--qn <x>`      | 清晰度别名或数字 id | 最高（`8k` / id 127）   | 请求画质**上限**：实际选取「id 不超过该值的最高流」；若超出账号权限会自动降级。别名见下方对照表，也可直接传 B 站数字 id（如 `--qn 80`）。 |
| `--audio`       | 开关（无值）        | 关                      | 只下载音频流并用 ffmpeg 转成 `.mp3`，不合成视频。                                                                                         |
| `--out <dir>`   | 目录路径            | `./downloads`           | 输出目录，不存在时自动创建。                                                                                                              |
| `--ffmpeg <p>`  | 可执行文件路径      | 在 PATH 中查找 `ffmpeg` | 当系统 PATH 里没有 ffmpeg 时，用它显式指定。                                                                                              |
| `--keep`        | 开关（无值）        | 关                      | 保留 `<out>/.tmp` 下的音视频中间文件（`*.v.m4s` / `*.a.m4s`）；默认混流完成后删除。                                                       |
| `--no-cookie`   | 开关（无值）        | 关                      | 不携带已保存的 cookie 下载，仅能拿到低画质（约 720 及以下）。                                                                             |
| `-h` / `--help` | 开关（无值）        | —                       | 打印内置帮助文本。                                                                                                                        |

> 无参数运行（或仅 `-h/--help`）会输出 `login` 与下载两组用法说明。

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

### 参数速查示例

```bash
node src/index.js BV1xx411c7mD                       # 默认第 1 个 P、最高画质
node src/index.js BV1xx411c7mD --p 2                 # 只要第 2 个 P
node src/index.js BV1xx411c7mD --qn 720              # 锁定 720P（免登录）
node src/index.js BV1xx411c7mD --qn 80               # 等价的数字 id 写法（1080P）
node src/index.js BV1xx411c7mD --audio --out ./mp3   # 仅音频，输出到 ./mp3
node src/index.js BV1xx411c7mD --keep                # 调试用：保留中间 m4s 文件
```

## 目录结构

```
src/
  index.js          CLI 入口，串联整条链路
  api/
    bili.js         nav / view / playurl(DASH) / html5 回退 / 选流
    login.js        二维码生成 + 轮询登录
  lib/
    http.js         UA/Referer 注入（破防盗链）
    wbi.js          WBI 签名（img_key+sub_key → w_rid）
    storage.js      cookies.json 读写
    download.js     流式下载 + 断点续传
    ffmpeg.js       混流 mp4 / 转 mp3
```

登录成功后 cookie 保存在项目根 `cookies.json`。

## 合规提示

仅用于个人学习/备份自己有权下载的内容，遵守 B 站用户协议与版权规定。

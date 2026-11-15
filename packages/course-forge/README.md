# Course Forge：视频/音频 -> 课程包流水线

> 详细使用指南（分步流程、产物说明、校对规则、故障排查）见仓库根目录 [README.forge.md](../../README.forge.md)。本文偏概览与速查。

把一段英文视频（影视/教学/Vlog）或音频（对白/歌曲）变成 Earthworm 自定义课程包（文本课程 + 视频同步播放，前端按时间戳 seek 视频原声，无时间戳时回退 TTS）：

1. **转写**：ffmpeg 提取音轨，docker 内的 faster-whisper 服务输出带词级时间戳的字幕；
2. **结构化**：本地 LLM（默认 ollama `qwen3:4b`，OpenAI 兼容接口可换任意云端）把字幕拆解成 Earthworm 式的「碎片 -> 组合 -> 完整句」课程 JSON；
3. **时间戳对齐**：把词级时间戳回填到每条 statement，供视频 seek 播放使用；
4. **产出**：生成可编辑的 `course.json`（含 `startTime`/`endTime`/`words`）；
5. **导入**：复制视频到 API 静态目录，POST `/course-pack` 写入数据库。

> 视频输入时时间戳天然与视频同步（同一音轨时间轴）；纯音频输入时时间戳仍产出，但前端走 TTS。

## 前置条件（全部项目内，无需 pip / 系统安装）

- `pnpm install`（ffmpeg 二进制由 `ffmpeg-static` 自动下载到 node_modules）
- Docker 运行中；首次会自动拉起 `asr` 服务（拉镜像 + 下载模型约 2GB，需要网络/代理）
- 本地 LLM：`ollama serve` + `ollama pull qwen3:4b`（或用环境变量换云端服务）

## 用法

```bash
# 视频输入（前端可播放原声片段）
pnpm forge -- --video "D:/media/friends_s01e01.mp4" --title "老友记 S01E01" --type dialogue

# 纯音频输入（前端走 TTS）
pnpm forge -- --audio "D:/path/to/audio.mp3" --title "某播客" --type dialogue

# 歌曲
pnpm forge -- --audio song.mp3 --title "某首歌" --type music

# 校对修改 course.json（改句子/翻译/顺序/时间戳）后直接导入，需要后端已启动：pnpm dev:serve
# 导入时视频输入会自动复制视频到 API 静态目录
pnpm forge:import -- --out output/<runId>
```

首次使用先应用数据库新列：`pnpm db:init`（schema 含 `course_packs.video`、`statements.start_time`/`end_time`/`words`）。

## 环境变量

| 变量                         | 默认                             | 说明                                                                                                                 |
| ---------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `FORGE_ASR_URL`              | `http://localhost:9000`          | ASR 服务地址（compose asr 服务的宿主端口）                                                                           |
| `FORGE_ASR_WAIT_MS`          | 15 分钟                          | 等待 ASR 容器健康的超时                                                                                              |
| `FORGE_ASR_STOP_AFTER`       | `1`                              | 转写后自动停止 ASR 容器释放显存；设为 `0` 保持常驻                                                                   |
| `FORGE_LLM_BASE_URL`         | `http://localhost:11434/v1`      | OpenAI 兼容端点（ollama / DeepSeek / OpenAI 均可）                                                                   |
| `FORGE_LLM_MODEL`            | `qwen3:4b`                       | 结构化模型；权重约 2.5GB，小显存友好，质量不够可试 `qwen3:8b` / `qwen3:14b` 或云端模型                               |
| `FORGE_LLM_API_KEY`          | `ollama`                         | 云端服务时填真实 key                                                                                                 |
| `FORGE_LLM_REASONING_EFFORT` | `none`                           | ollama 专用参数；非 ollama（如 DashScope）**必须置空**，请求里留空串即不发送该字段                                   |
| `FORGE_LLM_ENABLE_THINKING`  | 空（不发送）                     | 思考开关（`enable_thinking`）；qwen3.8-flash 等默认开思考的云端模型设 `false`，否则思考吃光 max_tokens、生成看似卡死 |
| `FORGE_LLM_MAX_TOKENS`       | 16000                            | 单次 LLM 输出上限（qwen-plus 支持 32768；本地开思考模式时可调大）                                                    |
| `FORGE_LLM_MAX_WORDS`        | 250                              | 单次 LLM 调用携带的最大词数；一个分块生成一门课，调大=课程更长                                                       |
| `FORGE_LLM_PREFLIGHT`        | `1`                              | LLM 调用前预检（服务连通/模型/显存）；`0` 关闭                                                                       |
| `FORGE_LLM_VRAM_STRICT`      | `1`                              | 显存不足时拦停；`0` 仅警告                                                                                           |
| `FORGE_LLM_VRAM_MARGIN_MB`   | 512                              | 显存估算余量（MB）                                                                                                   |
| `FORGE_API_URL`              | `http://localhost:3001`          | 导入目标 API                                                                                                         |
| `FORGE_COURSE_VIDEO_DIR`     | `apps/api/storage/course-video/` | 导入时视频复制目标目录                                                                                               |

以上变量也可以集中写进 `packages/course-forge/.env`（复制 `.env.example` 修改即可；
已存在的进程环境变量优先于 `.env` 文件；`.env` 已进包内 `.gitignore` 防泄漏 key）。

## ASR 转写服务配置（模型 / 镜像由你自行准备）

脚本只负责「拉起容器 + 调用 OpenAI 兼容接口」，具体用哪个镜像、下载哪个模型由你决定。默认镜像
`ghcr.io/speaches-ai/speaches:0.8.3-cuda`（即原 faster-whisper-server 改名后的项目，OpenAI 兼容，
支持 `verbose_json` 与 `timestamp_granularities[]`。**勿用 `latest-cpu`**，它停在 2025-09 旧版，
读不了新版 large-v3 权重仓库），相关配置都在 `docker-compose.yml` 的 `asr` 服务里：

- **模型**：`PRELOAD_MODELS`（默认 `["Systran/faster-whisper-large-v3"]`，启动时自动下载安装；客户端
  请求的 `model=whisper-1` 是 speaches 内置别名，恰好映射到它）。换模型需同步改这个列表与代码请求的
  `model` 字段；权重自动下载到项目内的 `./.volumes/asr-model-cache`（映射到容器
  `/home/ubuntu/.cache/huggingface`）。首次下载约 3GB；compose 配了 `HF_HUB_DISABLE_XET=1`
  禁用 Xet 加速通道（该通道在部分网络长连接会被中途掐断、留下损坏文件）。若下载因网络断开报错，
  重跑一次流水线或 `curl -X POST http://localhost:9000/v1/models/whisper-1` 即可断点续传。
  **不要**把 `HF_ENDPOINT` 指向 hf-mirror（其 `/api` 会 308 跳回官网，导致校验失败）；
  直连 huggingface.co 困难时给 Docker 配代理。
- **量化 / 设备**：`WHISPER__COMPUTE_TYPE`（默认 `float16`，CUDA GPU）。无独显时把 image 标签换成
  `:0.8.3-cpu`、`WHISPER__COMPUTE_TYPE` 改 `int8`，并去掉 compose 里的 GPU `deploy.resources` 段即可。
- **健康检查**：容器内 `GET :8000/health`（compose healthcheck 与脚本 `ensureAsrReady` 都用它，
  脚本还会兜底探测 `/v1/models`）。改端口请同步 compose 的 `ports`（宿主 `9000`→容器 `8000`）
  与 `FORGE_ASR_URL`。
- **词级时间戳**：脚本默认带 `timestamp_granularities[]=word` 请求；若所用 ASR 版本不支持会自动去掉该参数
  重试，`transcript.json` 仅存段级文本与起止时间（此时逐句时间戳精度降为段级，逐词高亮不可用）。因此换成任意 OpenAI 兼容转写服务也能跑。

> 想完全绕开 Docker 也行：只要有任意返回 `verbose_json`（含/不含词级时间戳均可）的
> `/v1/audio/transcriptions` 服务，把 `FORGE_ASR_URL` 指过去即可——脚本探测到服务已就绪就跳过拉容器。

## LLM 结构化配置

默认走本地 ollama（`FORGE_LLM_BASE_URL=http://localhost:11434/v1`、`FORGE_LLM_MODEL=qwen3:4b`）。
首次需 `ollama pull qwen3:4b`。显存 / 效果不满意时仅改环境变量即可换更大模型或切云端（代码不动）：
`FORGE_LLM_BASE_URL`、`FORGE_LLM_MODEL`、`FORGE_LLM_API_KEY`（如 DeepSeek：base `https://api.deepseek.com/v1`、
model `deepseek-chat`、key 填真实值）。

**推荐云端配置（阿里百炼 qwen-plus）**：复制 `.env.example` 为 `.env`、填入百炼 key 即可。要点：
`FORGE_LLM_REASONING_EFFORT=` 必须置空（ollama 专用参数会被 DashScope 拒绝）；预检对非 localhost
端点自动跳过 ollama 模型列表/显存检查；`response_format` 若不被支持，现有降级链自动落到
`json_object` / 纯文本，无需干预。

**质量护栏**：喂给模型前，流水线会把 ASR 断句碎片预拼成完整句（`mergeSegments`，只在句末标点断句，
长难句作为完整一句保留）；每门课产出后做质量校验（`evaluateCourseQuality`：单词列表课 / 完整句过少
两类劣化直接拦截），不达标会带着纠错说明自动重试一次，仍失败则报错退出，不会静默产出坏课。

## 原理与已知边界

- **视频**：ffmpeg `-vn` 提取音轨后转写；时间戳与视频共享同一时间轴，前端按 `startTime`/`endTime` seek 播放原声。视频格式建议 mp4（H.264+AAC）；非 mp4 导入时仅警告，不自动转码。
- **音频**：纯音频输入同样产出时间戳，但前端无视频可 seek，走 TTS 回退。
- **原声切片**：已移除（不再保留 `audio_url` 字段）；视频同步播放已覆盖原声需求。
- **音乐**：Whisper 对带伴奏音频识别率有限，效果差时优先用人声干声。
- **发音音标**（phonetic）由 LLM 生成，可能存在错误，导入前可抽查；留空不影响播放。
- **对齐**：LLM 产出句与 ASR 转写文本可能不完全一致，两遍匹配（锚点句 + 片段）仍有失败时置 null，前端该句回退 TTS。对齐成功率低于 85% 时流水线会告警。

## 测试

```bash
pnpm -F @earthworm/course-forge test
```

转写解析 / LLM 输出校验 / 预检 / 时间戳对齐均为纯函数单测，不需要 Docker、ollama 或 ffmpeg。

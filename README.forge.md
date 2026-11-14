> 本文档是 **Course Forge 视频/音频→课程包流水线** 的详细使用指南。
> 概览与环境变量速查见 [packages/course-forge/README.md](packages/course-forge/README.md)，本文讲「怎么用、每个产物是什么、出错怎么查」。

# Course Forge 使用指南

把一段英文视频（影视片段 / Vlog / 教学录像）或音频（对白 / 歌曲）变成 Earthworm 的自定义课程包：
**文本课程 + 视频同步播放**（前端按句子时间戳 seek 视频片段，无时间戳时回退 TTS）。

整体链路（全部本地脚本 + 人工校对，无上传界面、无 pip / 系统安装）：

```
视频 / 音频文件
  │  Step 1    转写        ffmpeg -vn 提取音轨 → docker 内 faster-whisper → 带词级时间戳的 transcript.json
  ▼
  │  Step 1.5  释放显存    转写完成后自动停止 ASR 容器，把显存让给 LLM
  ▼
  │  Step 2    结构化      本地/云端 LLM（OpenAI 兼容）把字幕拆成 Earthworm 式课程 JSON
  ▼
  │  Step 2.5  时间戳对齐   把词级时间戳回填到每条 statement → alignment.json（对齐报告）
  ▼
  │  Step 3    产出        course.json（含 startTime/endTime/words 时间戳）
  ▼
人工校对 course.json → forge:import 写入数据库（视频输入时同时复制视频到 API 静态目录）
```

一条命令跑完 Step 1–3，产出可编辑的 `course.json`；校对满意后再 `forge:import` 导入。

> **视频 vs 音频**：视频输入时时间戳天然与视频同步（ffmpeg 提取的音轨与视频共享同一时间轴），前端可 seek 播放原声片段；纯音频输入时时间戳仅供后续功能使用，当前前端走 TTS。

---

## 1. 一次性准备（前置条件）

只需要做一次。模型 / 镜像的下载与本地化由你负责，流水线只留好了配置开关（见 §6、§7）。

1. **装依赖**（项目内，ffmpeg 二进制由 `ffmpeg-static` 自动拉进 `node_modules`）：
   ```bash
   pnpm install
   ```
2. **应用数据库新列**（schema 含 `course_packs.video`、`statements.start_time`/`end_time`/`words`；本地库若已跑过可跳过）：
   ```bash
   pnpm db:init
   ```
3. **准备 ASR 转写服务**（二选一）：
   - 用项目自带的 docker 服务：确保 Docker 在跑即可，首次 `forge` 会自动
     `docker compose --profile asr up -d asr` 拉起并等你把模型下好（`asr` 服务不在 `docker:start` 里，纯按需）。
   - 或自备任意返回 `verbose_json` 的 OpenAI 兼容转写服务，设 `FORGE_ASR_URL` 指过去，脚本探测到就绪就不再拉容器。
   - 镜像选择、`PRELOAD_MODELS`、GPU/CPU、离线与 HF 镜像站等见 §6。
4. **准备 LLM**（结构化用，OpenAI 兼容接口）：默认本地 ollama
   ```bash
   ollama serve            # 若未常驻
   ollama pull qwen3:4b    # 默认模型；显存/效果不够见 §6、§7
   ```
   想切 DeepSeek / OpenAI 等云端，只改环境变量（见 §6），代码不动。

自检（可选，跑之前确认三方就绪）：

```bash
docker ps                                   # Docker 在跑
curl http://localhost:11434/v1/models       # ollama 可达（或你的云端）
# ASR 首次由脚本自动拉起；手动检查：curl http://localhost:9000/health
```

---

## 2. 命令总览

两条子命令都在**仓库根目录**用 pnpm 调；给脚本传参需要加一个 `--` 分隔符。

| 命令                       | 作用                           | 必需参数                          |
| -------------------------- | ------------------------------ | --------------------------------- |
| `pnpm forge -- ...`        | 跑完整流水线，产出一个运行目录 | `--video` 或 `--audio`、`--title` |
| `pnpm forge:import -- ...` | 导入课程包（复制视频 + POST）  | 无（`--out` 缺省=最近一次运行）   |

> `forge:import` 是根目录脚本名，底层调用 `packages/course-forge` 包内脚本 `import:course`（CLI 子命令 `import`）。

`forge` 的可选参数：

- `--type dialogue|music`：切分策略。`dialogue` 按话题分组、每课 5–10 个目标句；`music` 以每行歌词为候选句。默认 `dialogue`。
- `--desc <描述>`：课程包描述。缺省自动生成一句。
- `--language <代码>`：转写语言提示，默认 `en`。
- `--out <目录>`：自定义产物目录。缺省写入 `packages/course-forge/output/<runId>/`，`runId` 形如 `20261110-203012`。

> `--video` 与 `--audio` 二选一，至少提供一个。`forge:import` 不带 `--out` 时会自动选 `output/` 下**名字最大（即时间最新）**的运行目录，并在日志里回显所选目录，避免误操作到旧产物。

---

## 3. 完整流程示例（走一遍）

### 3a. 视频输入（推荐：前端可播放原声片段）

```bash
# ① 转写 + 结构化 + 时间戳对齐 + 产出
pnpm forge -- --video "D:/media/friends_s01e01.mp4" --title "老友记 S01E01" --type dialogue

# 控制台会打印：
#   [asr] 提交转写请求 ...          [forge] 转写完成：NN 段（词级时间戳：有）
#   [asr] 已停止 ASR 容器，显存让给 LLM
#   [llm] 结构化分析 ...            [forge] 结构化完成：1 课 / Y 条 statement
#   [forge] 对齐：XX/YY 条命中（成功率 ZZ%）
#   [forge] 产物目录：D:\...\output\20261110-203012
#   [forge] 下一步：校对 course.json，然后 pnpm forge:import ...

# ② 按 §5 校对 course.json（改文本/翻译/顺序）。改完直接保存即可，无需重跑任何命令。

# ③ 确认无误、且后端在跑（pnpm dev:serve），导入课程包：
pnpm forge:import -- --out "D:/english-for-fun/packages/course-forge/output/20261110-203012"
#   [import] 视频已复制到 apps/api/storage/course-video/20261110-203012.mp4
#   [import] 导入成功：coursePackId=...

# 打开客户端，在课程列表看到《老友记 S01E01》：句子按时间戳 seek 视频播放原声。
```

### 3b. 纯音频输入（前端走 TTS）

```bash
pnpm forge -- --audio "D:/media/podcast.mp3" --title "某播客" --type dialogue
# [forge] 提示：输入不是视频文件，时间戳仅供音频同步，导入后前端仍走 TTS/音频回退
```

**注意**：`--out` 用**绝对路径**最省事；相对路径按你当前所在目录解析。

---

## 4. 产物目录里都有什么

一次 `forge` 产出（下文用 `<out>` 代表 `output/<runId>`）：

| 文件 / 目录       | 谁生成   | 作用                                                                                    | 能否手改                   |
| ----------------- | -------- | --------------------------------------------------------------------------------------- | -------------------------- |
| `meta.json`       | Step 1   | 运行元信息（`runId`、`title`、`type`、`audioPath`、**视频输入时的 `videoPath`**、时间） | 可改 `title`/`description` |
| `transcript.json` | Step 1   | ASR 原始转写（词级时间戳 / 段级降级后的结构）                                           | 不建议改                   |
| `alignment.json`  | Step 2.5 | 时间戳对齐报告（每条 statement 的匹配方式与命中时间，可用于人工校对）                   | 只读参考                   |
| `course.json`     | Step 3   | **最终课程包**（含 `startTime`/`endTime`/`words` 时间戳），这是你要校对和导入的文件     | ✅ 主要校对对象            |
| `.work/`          | Step 1   | 转码中间 wav，用完即删                                                                  | —                          |

生命周期要点：

- `course.json` 是导入的唯一事实来源：改完保存直接 `forge:import`，不需要重跑任何产物生成。
- `forge:import` 会读取 `meta.json` 中的 `videoPath`，把视频文件复制到 API 静态目录（`apps/api/storage/course-video/`），然后连同 `video` URL 和时间戳一起 POST 给 `/course-pack`。
- 多个运行目录互不干扰，按 `runId` 时间戳区分；`forge:import` 缺省只认最新那个。
- `transcript.json` 与 `alignment.json` 保留作为参考，帮助校对时对照原始时间戳。

---

## 5. 校对 course.json（最关键的人工环节）

`course.json` 结构（与导入 `POST /course-pack` 的 body 一致）：

```jsonc
{
  "title": "老友记 S01E01",
  "description": "……",
  "cover": "",
  // "分课程"功能已删除：courses 是单一课程对象（不是数组）。
  // 其中 title/description 仅用于校对，入库的只有 statements。
  "courses": {
    "title": "点餐",
    "description": "",
    "statements": [
      {
        "english": "Can I get a coffee?",
        "chinese": "能给我来杯咖啡吗？",
        "phonetic": "…",
        "startTime": 12.34,
        "endTime": 14.56,
        "words": [
          { "word": "Can", "start": 12.34, "end": 12.5 },
          { "word": "I", "start": 12.5, "end": 12.6 },
        ],
      },
      {
        "english": "coffee",
        "chinese": "咖啡",
        "phonetic": "…",
        "startTime": 13.2,
        "endTime": 13.65,
        "words": [{ "word": "coffee", "start": 13.2, "end": 13.65 }],
      },
    ],
  },
}
```

字段规则：

- **`english` / `chinese`**：英文句子与中文释义，自由校对。LLM 默认从转写逐字摘取目标句，保留原文表达即可。
- **`phonetic`**：IPA 音标，由 LLM 生成，**可能有误**，导入前抽查；留空不影响播放。
- **`startTime` / `endTime`**：该句在视频中的起止秒数，由对齐步骤自动回填。如果明显偏差（ASR 或对齐出错），可手动调整或置 null（置 null 后该句回退 TTS 播放）。
- **`words`**：逐词时间戳，前端可用于逐词高亮。ASR 段级降级时为 null。

校对动作：

- 改 `english` / `chinese` / `phonetic`、删句、调整顺序、改课程包 `title`/`description`：直接编辑 `course.json` 保存，然后 `forge:import`。
- 改时间戳：对照 `alignment.json` 报告修改有偏差的 `startTime`/`endTime`。
- 想改 `type`（dialogue↔music）或重跑结构化：无法局部改，直接对新媒体重跑整条 `forge`。

---

## 6. 环境变量参考

流水线侧（`course-forge`，全部有合理默认，通常不用设；也可集中写进 `packages/course-forge/.env`，
复制 `.env.example` 即可，进程环境变量优先于该文件）：

| 变量                         | 默认                             | 说明                                                                                         |
| ---------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------- |
| `FORGE_ASR_URL`              | `http://localhost:9000`          | ASR 服务地址（compose `asr` 的宿主端口）。指到外部服务即绕过自动拉容器                       |
| `FORGE_ASR_WAIT_MS`          | 900000（15 分）                  | 拉起 asr 容器后等待健康检查的上限；首次下模型慢可调大                                        |
| `FORGE_ASR_STOP_AFTER`       | `1`（自动停止）                  | 转写结束后是否停止 ASR 容器释放显存；设为 `0` 保持常驻可加快下次转写                         |
| `FORGE_LLM_BASE_URL`         | `http://localhost:11434/v1`      | OpenAI 兼容 chat 端点（ollama / DeepSeek / OpenAI…）                                         |
| `FORGE_LLM_MODEL`            | `qwen3:4b`                       | 结构化模型；4B 本地模型已证实做不动本课程组装任务，推荐换云端 qwen-plus（见 `.env.example`） |
| `FORGE_LLM_API_KEY`          | `ollama`                         | 云端服务填真实 key                                                                           |
| `FORGE_LLM_MAX_TOKENS`       | 16000                            | 单次 LLM 输出上限                                                                            |
| `FORGE_LLM_REASONING_EFFORT` | `none`                           | ollama 专用参数；非 ollama（如 DashScope）**必须置空**，留空串即不发送该字段                 |
| `FORGE_LLM_MAX_WORDS`        | 250                              | 单次调用携带的最大词数；转写先预拼成完整句再分块，**一个分块生成一门课**                     |
| `FORGE_LLM_PREFLIGHT`        | `1`                              | LLM 调用前是否预检（服务连通/模型存在/显存余量）；设为 `0` 跳过                              |
| `FORGE_LLM_VRAM_STRICT`      | `1`                              | 显存估算不足时是否直接拦停；设为 `0` 仅警告（接受 CPU 卸载慢跑）                             |
| `FORGE_LLM_VRAM_MARGIN_MB`   | 512                              | 显存估算余量（KV cache + CUDA 上下文开销，MB）                                               |
| `FORGE_API_URL`              | `http://localhost:3001`          | 导入目标 API                                                                                 |
| `FORGE_COURSE_VIDEO_DIR`     | `apps/api/storage/course-video/` | 导入时视频复制目标目录（API 静态挂载到 `/course-video` 前缀）                                |

ASR 容器侧（改 `docker-compose.yml` 的 `asr` 服务）：

| 位置                    | 默认                                      | 说明                                                                                                                                                                                                                                                                                           |
| ----------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `image`                 | `ghcr.io/speaches-ai/speaches:0.8.3-cuda` | OpenAI 兼容转写服务 speaches（即原 faster-whisper-server 改名），支持 `verbose_json` + `timestamp_granularities[]`。**勿用 `latest-cpu`**：它停在 2025-09 旧版，读不了新版权重仓库。无 GPU 时改 `:0.8.3-cpu`，同时把 `WHISPER__COMPUTE_TYPE` 改为 `int8`                                       |
| `PRELOAD_MODELS`        | `["Systran/faster-whisper-large-v3"]`     | 启动时自动下载安装模型（客户端的 `model=whisper-1` 是 speaches 内置别名，映射到它）；权重存项目内 `./.volumes/asr-model-cache`。换模型要同步改请求里的 `model` 字段。个别网络长连接会被掐断，重复 `docker compose --profile asr up -d asr`（或脚本重试 POST /v1/models/whisper-1）即可断点续传 |
| `WHISPER__COMPUTE_TYPE` | `float16`（CUDA）                         | CPU 用 `int8`                                                                                                                                                                                                                                                                                  |
| `HF_HUB_DISABLE_XET`    | `1`                                       | 禁用 HF Xet 加速通道（`cas-server.xethub.hf.co` 长连接在部分网络会被中途掐断导致下载损坏），回退普通 HTTP                                                                                                                                                                                      |
| `ports`                 | `9000:8000`                               | 改端口要同步 `FORGE_ASR_URL`                                                                                                                                                                                                                                                                   |
| 健康检查                | 容器内 `:8000/health`                     | 脚本还会兜底探测 `/v1/models`                                                                                                                                                                                                                                                                  |

> 注意：**不要**把 `HF_ENDPOINT` 指向 hf-mirror——它的 `/api` 会 308 重定向回官网，反而让 `huggingface_hub` 校验失败。容器默认直连 huggingface.co；连不上时给 Docker 配代理。

---

## 7. 故障排查

| 现象                                     | 原因 / 处理                                                                                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[asr] docker compose 启动 asr 服务失败` | Docker 没跑 / 拉不到镜像（配代理）/ 镜像名不对。先手动 `docker compose --profile asr up -d asr` 看报错，或直接设 `FORGE_ASR_URL` 指向你自建的转写服务 |
| `[asr] 等待超时`                         | 首次在下模型，调大 `FORGE_ASR_WAIT_MS`；或看 `docker compose logs asr`                                                                                |
| `[asr] 转写结果为空`                     | 音频里没英文语音，或音乐伴奏太密（见下「音乐」）                                                                                                      |
| `[forge] 对齐成功率低于 85%`             | LLM 产出的句子与 ASR 转写文本有偏差（拼写/标点/合并拆句不同）。对照 `alignment.json` 检查失败条目，可手动在 `course.json` 修正时间戳                  |
| `[llm] 无法连接 …`                       | ollama 没起 / 没 `pull` 该模型 / 云端 key 或 base 不对。检查 `FORGE_LLM_*` 与 `ollama list`                                                           |
| `[llm] 输出结构校验失败`                 | 模型没按要求输出 JSON schema。换更强的模型或调低单次 `FORGE_LLM_MAX_WORDS`（分更多块），代码已内置 `json_schema→json_object→纯文本` 逐级降级          |
| `[import] 无法连接 API`                  | 后端没起。`pnpm dev:serve` 后重试，或核对 `FORGE_API_URL`                                                                                             |
| `[import] 视频不是 mp4`                  | 部分浏览器（Safari）不能播放 mkv/webm。用 ffmpeg 转成 H.264+AAC mp4 后重跑导入                                                                        |
| 页面全播 TTS、没有原声                   | 检查：① course.json 的 statement 是否有 `startTime`/`endTime`；② 视频输入时 `meta.json` 是否有 `videoPath`；③ 导入是否成功（日志有「视频已复制」）    |
| 歌曲识别差                               | Whisper 对带伴奏音频有限。优先喂**人声干声**                                                                                                          |
| 重复导入会不会产生重复课程包？           | 会。`forge:import` 每次都是**新建**一个课程包（`POST /course-pack`），不覆盖旧的；测试满意后如需清理，在客户端/API 删除旧包                           |

---

## 8. 客户端播放行为（导入后会怎样）

- **视频课程（有视频 + 时间戳）**：句子按 `startTime`/`endTime` seek 视频播放原声片段；逐词高亮依赖 `words`。
- **纯音频课程（无视频 / 时间戳缺失）**：回退服务端 TTS 播放。
- 客户端播放优先级：`audioUrl`（原声切片，当前流水线不产出）→ 视频区间 seek → TTS。
- **倍速 / 重复播放**：支持。

---

## 9. 测试

流水线里转写解析 / LLM 输出校验 / 预检 / 时间戳对齐都是**纯函数单测**，不需要 Docker、ollama 或 ffmpeg：

```bash
pnpm -F @earthworm/course-forge test
```

---

## 附：已知边界与后续

- v1 假设脚本、API、存储目录**同机**（本地开发形态）；线上上传界面属后续迭代。
- 视频格式建议 mp4（H.264+AAC）；非 mp4 只警告不自动转码，Safari 等浏览器可能无法播放。
- 原声切片（`audioUrl`）能力暂不产出，数据库字段保留；当前视频同步播放已覆盖原声需求。
- `phonetic` 由 LLM 生成，建议加词典校验器（待办）。
- 对齐失败（`startTime`/`endTime` 为 null）的句子在客户端回退 TTS，不影响整体流程。

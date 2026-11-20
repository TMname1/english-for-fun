# Course Forge：视频/音频 → 课程包流水线

把一段英文视频（影视片段 / Vlog / 教学录像）或音频（对白 / 歌曲）变成 Earthworm 的自定义课程包：
**文本课程 + 视频同步播放**（前端按句子时间戳 seek 视频片段，无时间戳时回退 TTS）。

整体链路（全部本地脚本 + 人工校对，无 pip / 系统安装）：

```
视频 / 音频文件
  │  Step 1    转写        ffmpeg -vn 提取音轨 → 百炼 Qwen-Audio-ASR（同步）→ 整段 text + 词级时间戳
  ▼
  │  Step 1.5  预处理      LLM 按语义拆成完整句（输出词序号分组）→ 代码合并碎片词 → transcript.json
  ▼
  │  Step 2    结构化      本地/云端 LLM（OpenAI 兼容）把每个完整句拆成 Earthworm 式课程 JSON
  ▼
  │  Step 2.5  时间戳对齐   把词级时间戳回填到每条 statement → alignment.json（对齐报告）
  ▼
  │  Step 3    产出        course.json（含 startTime/endTime/words 时间戳）
  ▼
人工校对 course.json → forge:import 写入数据库（视频输入时同时复制视频到 API 静态目录）
```

> **视频 vs 音频**：视频输入时时间戳天然与视频同步（ffmpeg 提取的音轨与视频共享同一时间轴），前端可 seek 播放原声片段；纯音频输入时时间戳仅供后续功能使用，当前前端走 TTS。

## 两种使用方式

- **Web GUI（推荐）**：客户端「导入视频」页（`apps/client/pages/video-clip.vue`）上传/选择视频 → 时间轴打切点勾选片段 → 后端 `POST /forge/jobs` 起流水线子进程 → 转写完成后在页面校对文字 → 自动续跑结构化、对齐并导入课程包。B 站下载（`/bili` 模块）完成后也会自动创建 forge 任务。
- **CLI**：本文下面的 `pnpm forge` / `pnpm forge:import` 命令，适合本地批处理与调试。

## 1. 一次性准备（前置条件）

只需要做一次。全部项目内依赖，无需 pip / 系统安装：

1. **装依赖**（ffmpeg 二进制由 `ffmpeg-static` 自动拉进 `node_modules`）：
   ```bash
   pnpm install
   ```
2. **应用数据库新列**（schema 含 `course_packs.video`、`statements.start_time`/`end_time`/`words`；本地库若已跑过可跳过）：
   ```bash
   pnpm db:init
   ```
3. **配置 ASR（阿里云百炼 Qwen-Audio-ASR）**：写进 `apps/api/.env`（参考 `.env.example`）：
   - `FORGE_ASR_API_KEY=sk-...`（百炼 DashScope Key，必填）；`FORGE_ASR_MODEL` 默认 `qwen-audio-3.1-asr-flash`。
   - 走 DashScope 原生 `multimodal-generation` 接口、**同步调用**（等待完整结果一次返回），固定返回句/词级时间戳（毫秒，流水线内换算为秒）。
   - flash 同步版建议单段音频 ≤5 分钟；超长选区请用切片分段（流水线支持多 clip 合并）。详见 §5。
4. **准备 LLM**（预处理拆句与结构化共用，OpenAI 兼容接口）：默认百炼云端（填 key 即可）；想用本地 ollama：
   ```bash
   ollama serve            # 若未常驻
   ollama pull qwen3:4b    # 把 FORGE_LLM_BASE_URL 改回 http://localhost:11434/v1
   ```
   想切 DeepSeek / OpenAI / 百炼等云端，只改环境变量（见 §5），代码不动。

自检（可选，跑之前确认三方就绪）：

```bash
curl http://localhost:11434/v1/models       # ollama 可达（或你的云端）
# ASR 走百炼云 API，无需本地服务；确认 .env 里 FORGE_ASR_API_KEY 已填即可
```

## 2. 命令总览与完整示例

两条子命令都在**仓库根目录**用 pnpm 调；给脚本传参需要加一个 `--` 分隔符。

| 命令                       | 作用                           | 必需参数                          |
| -------------------------- | ------------------------------ | --------------------------------- |
| `pnpm forge -- ...`        | 跑完整流水线，产出一个运行目录 | `--video` 或 `--audio`、`--title` |
| `pnpm forge:import -- ...` | 导入课程包（复制视频 + POST）  | 无（`--out` 缺省=最近一次运行）   |

> `forge:import` 是根目录脚本名，底层调用包内脚本 `import:course`（CLI 子命令 `import`）。

`forge` 的可选参数：

- `--type dialogue|music`：内容类型，写入 `meta.json`（对白/歌曲）。默认 `dialogue`。
- `--desc <描述>`：课程包描述。缺省自动生成一句。
- `--language <代码>`：转写语言提示，默认 `en`。
- `--out <目录>`：自定义产物目录。缺省写入 `apps/api/output/<runId>/`，`runId` 形如 `20261110-203012`。

> `--video` 与 `--audio` 二选一，至少提供一个。`forge:import` 不带 `--out` 时会自动选 `output/` 下**名字最大（即时间最新）**的运行目录，并在日志里回显所选目录，避免误操作到旧产物。`--out` 用**绝对路径**最省事；相对路径按你当前所在目录解析。

### 2a. 视频输入（推荐：前端可播放原声片段）

```bash
# ① 转写 + 结构化 + 时间戳对齐 + 产出
pnpm forge -- --video "D:/media/friends_s01e01.mp4" --title "老友记 S01E01" --type dialogue

# 控制台会打印：
#   [asr] 提交转写请求 ...（同步等待完整结果）
#   [preprocess] 段 1/1 完成：NN 个碎片词 -> MM 个完整句（合并后 KK 词）
#   [forge] 转写 + 预处理完成：MM 个完整句（词级时间戳：有）
#   [llm] MM 个句子，一句一调用 ...   [forge] 结构化完成：1 课 / Y 条 statement
#   [forge] 对齐：XX/YY 条命中（成功率 ZZ%）
#   [forge] 产物目录：D:\...\output\20261110-203012
#   [forge] 下一步：校对 course.json，然后 pnpm forge:import ...

# ② 按 §4 校对 course.json（改文本/翻译/顺序）。改完直接保存即可，无需重跑任何命令。

# ③ 确认无误、且后端在跑（pnpm dev:serve），导入课程包：
pnpm forge:import -- --out "D:/english-for-fun/apps/api/output/20261110-203012"
#   [import] 视频已上传到对象存储：course-video/20261110-203012.mp4
#   [import] 导入成功：coursePackId=...

# 打开客户端，在课程列表看到《老友记 S01E01》：句子按时间戳 seek 视频播放原声。
```

### 2b. 纯音频输入（前端走 TTS）

```bash
pnpm forge -- --audio "D:/media/podcast.mp3" --title "某播客" --type dialogue
# [forge] 提示：输入不是视频文件，时间戳仅供音频同步，导入后前端仍走 TTS/音频回退

# 歌曲
pnpm forge -- --audio song.mp3 --title "某首歌" --type music
```

## 3. 产物目录里都有什么

一次 `forge` 产出（下文用 `<out>` 代表 `output/<runId>`）：

| 文件 / 目录           | 谁生成   | 作用                                                                                    | 能否手改                   |
| --------------------- | -------- | --------------------------------------------------------------------------------------- | -------------------------- |
| `meta.json`           | Step 1   | 运行元信息（`runId`、`title`、`type`、`audioPath`、**视频输入时的 `videoPath`**、时间） | 可改 `title`/`description` |
| `transcript.json`     | Step 1.5 | **预处理后**的转写：一个 segment 即一个完整句，碎片词已合并（词级时间戳 / 段级降级）    | GUI 流程可人工校对         |
| `transcript.raw.json` | Step 1   | 原始 ASR 转写（整段 text + 未合并的碎片词），供回溯对照                                 | 不建议改                   |
| `clips.json`          | Step 1   | 仅切片流程：选中的时间区间，structure 阶段据此重打 clipIndex                            | 不建议改                   |
| `alignment.json`      | Step 2.5 | 时间戳对齐报告（每条 statement 的匹配方式与命中时间，可用于人工校对）                   | 只读参考                   |
| `course.json`         | Step 3   | **最终课程包**（含 `startTime`/`endTime`/`words` 时间戳），这是你要校对和导入的文件     | ✅ 主要校对对象            |
| `.work/`              | Step 1   | 转码中间 wav，用完即删                                                                  | —                          |

生命周期要点：

- `course.json` 是导入的唯一事实来源：改完保存直接 `forge:import`，不需要重跑任何产物生成。
- `forge:import` 会读取 `meta.json` 中的 `videoPath`，把视频上传到对象存储 `course-video/<runId>.<ext>`、JSON 产物上传到 `forge/<runId>/`（S3 配置见 `.env` 的 `S3_*`，dev 默认 MinIO），然后连同 `video` 对象键和时间戳一起 POST 给 `/course-pack`。
- 多个运行目录互不干扰，按 `runId` 时间戳区分；`forge:import` 缺省只认最新那个。
- `transcript.json` 与 `alignment.json` 保留作为参考，帮助校对时对照原始时间戳。

## 4. 校对 course.json（最关键的人工环节）

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

## 5. 环境变量参考

全部有合理默认，通常不用设；也可集中写进 `apps/api/.env`（参考 `.env.example`，
已存在的进程环境变量优先于该文件；`.env` 已进包内 `.gitignore` 防泄漏 key）：

| 变量                         | 默认                              | 说明                                                                                                                                                                                                                                  |
| ---------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FORGE_ASR_BASE_URL`         | 百炼 `multimodal-generation` 端点 | DashScope Qwen-Audio-ASR 原生接口地址（非 OpenAI 兼容）                                                                                                                                                                               |
| `FORGE_ASR_MODEL`            | `qwen-audio-3.1-asr-flash`        | 非实时 ASR 模型；同步返回整段 text + 句/词级毫秒时间戳（流水线换算为秒）                                                                                                                                                              |
| `FORGE_ASR_API_KEY`          | 空（**必填**）                    | 百炼 DashScope API Key（`sk-` 开头）                                                                                                                                                                                                  |
| `FORGE_ASR_TIMEOUT_MS`       | 180000（3 分）                    | 单次转写请求超时；同步等待完整结果，长音频可调大。flash 同步版建议单段 ≤5 分钟，超长请用切片分段                                                                                                                                      |
| `FORGE_LLM_BASE_URL`         | `http://localhost:11434/v1`       | OpenAI 兼容 chat 端点（ollama / DeepSeek / OpenAI…）                                                                                                                                                                                  |
| `FORGE_LLM_MODEL`            | `tongyi-xiaomi-analysis-flash`    | 句子分析（结构化组装链）模型；与预处理模型分开配置，共用 base URL / API Key（见 `.env.example`）                                                                                                                                      |
| `FORGE_PREPROCESS_MODEL`     | `qwen3.8-flash`                   | 预处理（拆句）模型；本地 ollama 时两个变量可设同一模型                                                                                                                                                                                |
| `FORGE_LLM_API_KEY`          | `ollama`                          | 云端服务填真实 key                                                                                                                                                                                                                    |
| `FORGE_LLM_MAX_TOKENS`       | 16000                             | 单次 LLM 输出上限（qwen-plus 支持 32768；本地开思考模式时可调大）                                                                                                                                                                     |
| `FORGE_LLM_CONCURRENCY`      | 10                                | 一句一调用的并发上限：同时发起多少个句子的模型调用（不是把多少句丢给一次调用）                                                                                                                                                        |
| `FORGE_LLM_REASONING_EFFORT` | `none`                            | ollama 专用参数；非 ollama（如 DashScope）**必须置空**，留空串即不发送该字段                                                                                                                                                          |
| `FORGE_LLM_ENABLE_THINKING`  | 空（不发送）                      | 思考开关（`enable_thinking`）；qwen3.8-flash 等默认开思考的云端模型设 `false`，否则思考吃光 max_tokens、生成看似卡死                                                                                                                  |
| `FORGE_LLM_PREFLIGHT`        | `1`                               | LLM 调用前是否预检（服务连通/模型存在/显存余量）；设为 `0` 跳过                                                                                                                                                                       |
| `FORGE_LLM_VRAM_STRICT`      | `1`                               | 显存估算不足时是否直接拦停；设为 `0` 仅警告（接受 CPU 卸载慢跑）                                                                                                                                                                      |
| `FORGE_LLM_VRAM_MARGIN_MB`   | 512                               | 显存估算余量（KV cache + CUDA 上下文开销，MB）                                                                                                                                                                                        |
| `FORGE_API_URL`              | `http://localhost:3001`           | 导入目标 API                                                                                                                                                                                                                          |
| `S3_*`                       | dev MinIO 默认值                  | 对象存储配置（`S3_ENDPOINT`/`S3_REGION`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`/`S3_BUCKET`/`S3_FORCE_PATH_STYLE`）；导入时视频与 JSON 产物上传到这里，与 `apps/api/.env` 保持一致，prod 换阿里云 OSS 见根目录 `README.env.prod.md` |

## 6. ASR 转写配置（阿里云百炼 Qwen-Audio-ASR）

转写走百炼 DashScope 的 **非实时语音识别**（`multimodal-generation` 原生接口，**同步调用**），不再依赖本地 Docker 容器、模型下载或 GPU：

- **鉴权**：只需 `FORGE_ASR_API_KEY`（百炼 `sk-` Key）；`FORGE_ASR_BASE_URL` 默认官方端点，`FORGE_ASR_MODEL` 默认 `qwen-audio-3.1-asr-flash`。
- **音频入参**：流水线把音轨转成 16k 单声道 PCM wav，再以 `data:audio/wav;base64,...` data URI 放进请求体上传，无需公网 URL/OSS。
- **时间戳**：模型固定返回句级与词级时间戳（单位**毫秒**，流水线内换算为秒，写进 `transcript.json` 的 `segments[].{start,end}` 与 `words[].{start,end}`），供逐词高亮与视频 seek 同步。词文字会并入其后标点（与下游对齐口径一致）。
- **同步返回**：不带 `X-DashScope-SSE` 头，等待完整结果一次返回；`output.sentence` 为单个句子对象，含整段 `text` 与全部词（`words`）。整段文本随后交给预处理步骤拆句。
- **时长上限**：flash 同步版建议单段 ≤5 分钟，超过会直接报错；长内容请用前端切片，流水线按 clip 分段转写再合并。
- **语言**：请求带 `language_hints`（en/zh/ja…），缺省自动识别。

## 7. 句子预处理（ASR 之后、结构化之前）

ASR 返回的是整段文本 + 碎片词表：一个词可能被拦腰拆成多个碎片（`Genu`+`inely`、`I`+`'`+`ve`）。
预处理把整段 `text` 和编号词表交给 `FORGE_PREPROCESS_MODEL`（默认 `qwen3.8-flash`），由模型**按语义理解**拆成完整句子（不局限于标点），
只输出每句包含的词序号（`{"sentences":[[0,1,2],[3,4,...]]}`）；代码校验序号必须升序连续、不重不漏覆盖全部词，
然后确定性地合并碎片词、从原始 ASR 词取 `start`/`end`——**时间戳零幻觉**。

- 每个 clip 的转写单独预处理（天然不跨 clip 拼句），失败自动重试一次，仍不合格则整体报错。
- 输出仍是标准 `Transcript`：一个 `segment` 即一个完整句，`text = words.join(" ")`。
  `transcript.json` 存预处理后的结果（GUI 人工校对看到的即完整句），`transcript.raw.json` 保留原始 ASR 结果供回溯。
- 下游结构化与对齐不再做代码拼句：直接以 segment 为句子单位。

## 8. LLM 结构化配置

模型默认：预处理 `FORGE_PREPROCESS_MODEL=qwen3.8-flash`、句子分析 `FORGE_LLM_MODEL=tongyi-xiaomi-analysis-flash`（百炼云端），
两者共用 `FORGE_LLM_BASE_URL` / `FORGE_LLM_API_KEY`。本地 ollama 时把 base URL 改回
`http://localhost:11434/v1`、两个模型变量设为已 pull 的本地模型（如 `qwen3:4b`，首次需 `ollama pull`）。
显存 / 效果不满意时仅改环境变量即可换模型或切云端（代码不动）：
`FORGE_LLM_BASE_URL`、`FORGE_LLM_MODEL`、`FORGE_PREPROCESS_MODEL`、`FORGE_LLM_API_KEY`（如 DeepSeek：base `https://api.deepseek.com/v1`、
model `deepseek-chat`、key 填真实值）。

**推荐云端配置（阿里百炼）**：复制 `.env.example` 为 `.env`、填入百炼 key 即可。要点：
`FORGE_LLM_REASONING_EFFORT=` 必须置空（ollama 专用参数会被 DashScope 拒绝）；预检对非 localhost
端点自动跳过 ollama 模型列表/显存检查；`response_format` 若不被支持，现有降级链自动落到
`json_object` / 纯文本，无需干预。

**质量护栏**：预处理已把转写拆成完整句（一个 segment 即一句），结构化**一句一调用**：每个完整句
单独交给模型拆成碎片并逐级拼回完整原句，多个句子按 `FORGE_LLM_CONCURRENCY` 并发发起。每次产出后做
完整原句校验（`containsFullSentence`：组装链里必须有一行逐字等于该原句，丢句 / 漏词 / 把 `don't` 展开成
`do not` 都判失败），失败带纠错说明自动重试一次，仍失败则整体报错退出——这样模型无法把任何一句悄悄
丢弃或改写。

## 9. 故障排查

| 现象                             | 原因 / 处理                                                                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[asr] 未配置 FORGE_ASR_API_KEY` | 在 `apps/api/.env` 填百炼 DashScope Key（`sk-` 开头）                                                                                              |
| `[asr] 转写请求失败（HTTP …）`   | Key 失效 / 欠费 / 网络不通 / 模型名不对。核对 `FORGE_ASR_API_KEY`、`FORGE_ASR_MODEL`、`FORGE_ASR_BASE_URL`                                         |
| `[asr] …超过单段上限 300s`       | flash 同步版建议 ≤5 分钟。用前端切片把选区缩短，或分段转写（流水线按 clip 合并）                                                                   |
| `[asr] 转写结果为空`             | 音频里没语音，或音乐伴奏太密（见下「音乐」）                                                                                                       |
| `[preprocess] …最终失败`         | 预处理 LLM 拆句输出重试后仍不合格（词序号分组不合法/结构错误）。换更强的 `FORGE_PREPROCESS_MODEL`，或检查该段转写是否异常                          |
| `[forge] 对齐成功率低于 85%`     | LLM 产出的句子与 ASR 转写文本有偏差（拼写/标点/合并拆句不同）。对照 `alignment.json` 检查失败条目，可手动在 `course.json` 修正时间戳               |
| `[llm] 无法连接 …`               | ollama 没起 / 没 `pull` 该模型 / 云端 key 或 base 不对。检查 `FORGE_LLM_*` 与 `ollama list`                                                        |
| `[llm] 输出结构校验失败`         | 模型没按要求输出 JSON schema。换更强的模型，代码已内置 `json_schema→json_object→纯文本` 逐级降级                                                   |
| `[import] 无法连接 API`          | 后端没起。`pnpm dev:serve` 后重试，或核对 `FORGE_API_URL`                                                                                          |
| `[import] 视频不是 mp4`          | 部分浏览器（Safari）不能播放 mkv/webm。用 ffmpeg 转成 H.264+AAC mp4 后重跑导入                                                                     |
| 页面全播 TTS、没有原声           | 检查：① course.json 的 statement 是否有 `startTime`/`endTime`；② 视频输入时 `meta.json` 是否有 `videoPath`；③ 导入是否成功（日志有「视频已复制」） |
| 歌曲识别差                       | ASR 对带伴奏音频有限。优先喂**人声干声**                                                                                                           |
| 重复导入会不会产生重复课程包？   | 会。`forge:import` 每次都是**新建**一个课程包（`POST /course-pack`），不覆盖旧的；测试满意后如需清理，在客户端/API 删除旧包                        |

## 10. 客户端播放行为（导入后会怎样）

- **视频课程（有视频 + 时间戳）**：句子按 `startTime`/`endTime` seek 视频播放原声片段；逐词高亮依赖 `words`。
- **纯音频课程（无视频 / 时间戳缺失）**：回退服务端 TTS 播放。
- 客户端播放优先级：视频区间 seek → TTS（原声切片能力已移除）。
- **倍速 / 重复播放**：支持。

## 11. 原理与已知边界

- **视频**：ffmpeg `-vn` 提取音轨后转写；时间戳与视频共享同一时间轴。视频格式建议 mp4（H.264+AAC）；非 mp4 导入时仅警告，不自动转码，Safari 等浏览器可能无法播放。
- **音频**：纯音频输入同样产出时间戳，但前端无视频可 seek，走 TTS 回退。
- **原声切片**：已移除（`statements` 不再保留 `audio_url` 字段）；视频同步播放已覆盖原声需求。
- **音乐**：带伴奏音频的语音识别率有限，效果差时优先用人声干声。
- **发音音标**（phonetic）由 LLM 生成，可能存在错误，导入前可抽查；留空不影响播放。词典校验器为待办。
- **断句**由预处理 LLM 按语义完成（不局限于标点）；下游结构化/对齐以 segment 为句子单位，不再做代码拼句。人工校对（GUI）增删词后句子完整性由校对者负责。
- **对齐**：LLM 产出句与 ASR 转写文本可能不完全一致，两遍匹配（锚点句 + 片段）仍有失败时置 null，前端该句回退 TTS，不影响整体流程。对齐成功率低于 85% 时流水线会告警。
- v1 假设脚本、API、存储目录**同机**（本地开发形态）；Web GUI 已覆盖上传与校对，线上多人形态属后续迭代。

## 12. 测试

```bash
pnpm -F api test:unit
```

转写解析 / 预处理分组校验与碎片合并 / LLM 输出校验 / 预检 / 时间戳对齐均为纯函数单测，不需要 Docker、ollama 或 ffmpeg。

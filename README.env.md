# 环境变量说明（README.env.md）

本项目是多包仓库（pnpm workspace），各包各自读取 `.env`。本文档汇总**所有需要关注的环境变量**、它们所在的文件、用途、是否必填与默认值。

> 真实 `.env` / `.env.test` / `.env.prod` 均已在 `.gitignore` 中，**不会提交**；仓库里只保留 `.env.example` 模板。新环境请从对应 `.example` 复制后填写。

## 文件总览

| 文件                         | 所属包                        | 读取方式                                                                                             | 说明                                 |
| ---------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `apps/api/.env`              | 后端 API                      | NestJS `ConfigModule`（默认 `.env`；`NODE_ENV=test` 读 `.env.test`，`NODE_ENV=prod` 读 `.env.prod`） | 后端运行时配置                       |
| `apps/client/.env`           | 前端 Nuxt                     | `process.env` → `runtimeConfig`                                                                      | 前端构建/运行配置                    |
| `packages/course-forge/.env` | Course Forge 视频转课程流水线 | 自定义加载（已存在的进程环境变量优先于本文件）                                                       | ASR / LLM / 导入配置                 |
| `packages/db`                | 数据库                        | `DATABASE_URL`（drizzle 迁移、`db.ts`）                                                              | 迁移与连接复用 API 的 `DATABASE_URL` |

---

## 一、后端 API（`apps/api/.env`）

| 变量               | 必填  | 默认值                          | 用途                                                                                                           |
| ------------------ | ----- | ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`     | ✅ 是 | 无                              | Postgres 连接串，如 `postgres://postgres:password@localhost:5433/earthworm`。迁移（drizzle）与运行时都依赖它。 |
| `NODE_ENV`         | 否    | 空                              | 选择加载哪个 env 文件并影响行为：`test` → `.env.test`，`prod` → `.env.prod`，其它 → `.env`。                   |
| `PORT`             | 否    | `3001`                          | API 监听端口（`main.ts`）。                                                                                    |
| `TTS_STORAGE_DIR`  | 否    | `apps/api/storage/tts`          | Edge TTS 生成的 mp3 缓存目录。                                                                                 |
| `TTS_PROXY_URL`    | 否    | 空                              | 访问 Edge TTS 服务所用 HTTP 代理，如 `http://127.0.0.1:10809`。国内网络访问微软 TTS 时常用。                   |
| `COURSE_AUDIO_DIR` | 否    | `apps/api/storage/course-audio` | 挂载到 `/course-audio` 前缀的真实音频目录。                                                                    |
| `COURSE_VIDEO_DIR` | 否    | `apps/api/storage/course-video` | 课程视频（上传 / B 站下载 / Forge 产物）存放目录，挂载到 `/course-video`。                                     |
| `FORGE_REPO_ROOT`  | 否    | 自动推断                        | 覆盖仓库根目录定位，供 Forge runner 子进程使用。一般无需设置。                                                 |

**遗留 / 未被代码读取的变量（可忽略，无需填写）：**

- `SECRET`：出现在 `.env.example` / `.env`，源自上游 earthworm 的 JWT 鉴权，**当前后端代码没有任何地方读取它**。
- `BACKEND_ENDPOINT`：出现在本地 `apps/api/.env`，**代码中无引用**。

### 测试环境（`apps/api/.env.test`，模板 `.env.test.example`）

`NODE_ENV=test`（如跑 e2e / vitest）时读取。需要一套**独立的测试库**：

```
DATABASE_URL="postgres://test:password@localhost:5480/earthworm_test"
```

（同样可带 `SECRET`，但当前未被使用。）

---

## 二、前端 Client（`apps/client/.env`）

通过 Nuxt `runtimeConfig` 暴露给浏览器，因此**这些值会打包进前端产物，切勿在此放任何密钥**。

| 变量          | 必填  | 默认值            | 用途                                                                                                           |
| ------------- | ----- | ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `API_BASE`    | ✅ 是 | 空                | 后端 API 基址，如 `http://localhost:3001`。前端所有请求（含 `/bili`、`/forge`、`course-pack`）以此为 baseURL。 |
| `ALLOW_FORGE` | 否    | 显示（除非 `=0`） | 是否显示“导入视频”入口。生产环境设为 `0` 可关闭；非 `0` 均视为开启。                                           |
| `CLARITY`     | 否    | 空                | Microsoft Clarity 统计脚本的 tag id。**仅在 `NODE_ENV=production` 构建时注入**，开发环境无效。                 |
| `NODE_ENV`    | 否    | 空                | `production` 才会注入 Clarity；`development` 走本地逻辑。                                                      |

> 说明：`HELP_DOCS_URL` 曾在前端使用，现已从 `nuxt.config` 移除、**代码不再读取**（本地 `.env` 里若残留可删除）。

---

## 三、Course Forge 流水线（`packages/course-forge/.env`）

用于“视频 → ASR 转写 → LLM 组装课程 → 导入后端”。加载规则：**已在进程中设置的同名环境变量优先于此文件**，本文件只填充未设置的项。

### 3.1 ASR（语音转写，默认走阿里云百炼 Qwen-Audio-ASR 云 API）

| 变量                   | 必填  | 默认值                                                                                 | 用途                                                                                    |
| ---------------------- | ----- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `FORGE_ASR_API_KEY`    | ✅ 是 | 空                                                                                     | 百炼 DashScope API Key（`sk-` 开头）。未配置会直接报 `[asr] 未配置 FORGE_ASR_API_KEY`。 |
| `FORGE_ASR_BASE_URL`   | 否    | `https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation` | ASR 端点（DashScope 原生 multimodal-generation，非 OpenAI 兼容）。                      |
| `FORGE_ASR_MODEL`      | 否    | `qwen-audio-3.1-asr-flash`                                                             | ASR 模型；同步返回整段 text + 句/词级毫秒时间戳。                                       |
| `FORGE_ASR_TIMEOUT_MS` | 否    | `180000`（3 分钟）                                                                     | 单次转写请求超时。长音频可调大；flash 同步版单段建议 ≤5 分钟，超长用切片分段。          |

### 3.2 LLM（预处理拆句与课程结构化）

| 变量                         | 必填   | 默认值                         | 用途                                                                                                                                              |
| ---------------------------- | ------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FORGE_LLM_BASE_URL`         | 否     | `http://localhost:11434/v1`    | OpenAI 兼容 chat 端点（ollama / DashScope / DeepSeek / OpenAI…）。                                                                                |
| `FORGE_LLM_MODEL`            | 否     | `tongyi-xiaomi-analysis-flash` | 句子分析（结构化组装链）模型。与预处理模型分开配置，共用 base URL / API Key。                                                                     |
| `FORGE_PREPROCESS_MODEL`     | 否     | `qwen3.8-flash`                | 预处理（拆句）模型。本地 ollama 时两个变量可设同一模型。                                                                                          |
| `FORGE_LLM_API_KEY`          | 视服务 | `ollama`                       | 云端服务必须填真实 Key；本地 ollama 可留默认。                                                                                                    |
| `FORGE_LLM_REASONING_EFFORT` | 否     | `none`                         | ollama 专用参数（`none` 关闭思考）。**非 ollama（如 DashScope）必须置空**（`FORGE_LLM_REASONING_EFFORT=`），否则请求被拒。置空即不发送该字段。    |
| `FORGE_LLM_ENABLE_THINKING`  | 否     | 空（不发送）                   | 思考开关（`enable_thinking`）。`qwen3.8-flash` 等默认开思考的云端模型设 `false`，否则思考吃光 `max_tokens`、看似卡死。ollama 不识别该字段时留空。 |
| `FORGE_LLM_MAX_TOKENS`       | 否     | `16000`                        | 单次 LLM 输出上限（qwen-plus 上限 32768）。                                                                                                       |
| `FORGE_LLM_PREFLIGHT`        | 否     | `1`                            | 调用前是否预检（连通 / 模型存在 / 显存）。`0` 跳过。                                                                                              |
| `FORGE_LLM_VRAM_STRICT`      | 否     | `1`                            | 显存估算不足时是否直接拦停。`0` 仅警告（接受 CPU 卸载慢跑）。仅本地 ollama/GPU 场景相关。                                                         |
| `FORGE_LLM_VRAM_MARGIN_MB`   | 否     | `512`                          | 显存估算余量（MB，KV cache + CUDA 上下文）。                                                                                                      |

### 3.3 导入后端

| 变量                     | 必填 | 默认值                           | 用途                                                       |
| ------------------------ | ---- | -------------------------------- | ---------------------------------------------------------- |
| `FORGE_API_URL`          | 否   | `http://localhost:3001`          | 课程导入目标 API 地址。                                    |
| `FORGE_COURSE_VIDEO_DIR` | 否   | `apps/api/storage/course-video/` | 导入时视频复制目标目录（API 静态挂载到 `/course-video`）。 |

### 3.4 流水线运行时变量（由后端自动注入，**无需手动配置**）

后端通过 `runner-client` 以子进程方式跑 `pipeline-runner`，会传入：`FORGE_PHASE`（`transcribe`\|`structure`）、`FORGE_OUT_DIR`、`FORGE_MEDIA_PATH`、`FORGE_TITLE`、`FORGE_TYPE`（`dialogue`\|`music`）、`FORGE_CLIPS`（`[{start,end}]` JSON）、`FORGE_LANGUAGE`、`FORGE_DESC`。仅在你**手动跑 CLI/子进程**时才需要了解，日常配置不用填。

---

## 四、最小可用配置示例

**apps/api/.env**

```
DATABASE_URL="postgres://postgres:password@localhost:5433/earthworm"
# PORT=3001
# TTS_PROXY_URL="http://127.0.0.1:10809"   # 国内访问 Edge TTS 时再开
```

**apps/client/.env**

```
API_BASE="http://localhost:3001"
# ALLOW_FORGE=0          # 生产关闭“导入视频”
# CLARITY=<your-id>      # 生产统计
```

**packages/course-forge/.env**（仅用视频转课程功能时才需要）

```
FORGE_ASR_API_KEY=sk-你的百炼Key
FORGE_LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
FORGE_LLM_MODEL=tongyi-xiaomi-analysis-flash
FORGE_PREPROCESS_MODEL=qwen3.8-flash
FORGE_LLM_API_KEY=sk-你的百炼Key
FORGE_LLM_REASONING_EFFORT=
FORGE_LLM_ENABLE_THINKING=false
```

---

## 五、安全提醒

- 真实 Key（`FORGE_*_API_KEY`）**只放本地 `.env`，绝不提交**（已 gitignore）。
- 前端 `apps/client/.env` 的值会打包进浏览器产物，**禁止放任何密钥**，只放 `API_BASE` 等公开配置。
- 若本地 `packages/course-forge/.env` 里填入的是真实百炼 Key，请注意该 Key 的额度与轮换；如机器共享或曾误传，建议尽快在服务商控制台吊销重发。

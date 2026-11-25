# 开发环境环境变量配置（README.env.dev.md）

本文列出**本地开发**需要配置的全部环境变量。生产部署见 `README.env.prod.md`；登录凭证说明见 `README.login.md`。

> **为什么没有 `.env.dev`？** 本项目采用「缺省即开发」约定：env 文件按 `NODE_ENV` 白名单映射
> （`prod` → `.env.prod`、`test` → `.env.test`），查不到一律回退 `.env`，所以 **`.env` 就是 dev 环境文件**。
> 本地开发无需设置 `NODE_ENV`；dotenv / Nuxt / drizzle-kit 等工具也默认读 `.env`，零配置即可启动。
> prod / test 属于「偏离默认」的场景，才需要显式文件名 + 显式 `NODE_ENV` 切换。

本项目是多包仓库（pnpm workspace），各包各自读取 `.env`。真实 `.env` / `.env.test` / `.env.prod` 均已 gitignore，
仓库只保留 `.env.example` 模板——新环境从对应 `.example` 复制后填写即可。

## 文件总览

| 文件                            | 所属包                        | 读取方式                                                                                             | 何时需要           |
| ------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------ |
| `apps/api/.env`                 | 后端 API                      | NestJS `ConfigModule`（默认 `.env`；`NODE_ENV=test` 读 `.env.test`，`NODE_ENV=prod` 读 `.env.prod`） | ✅ 必须            |
| `apps/client/.env`              | 前端 Nuxt                     | `process.env` → `runtimeConfig`                                                                      | ✅ 必须            |
| `apps/api/.env.test`            | 后端 API（测试）              | `NODE_ENV=test` 时读取                                                                               | 跑 e2e / vitest 时 |
| `apps/api/.env`（FORGE\_\* 段） | Course Forge 视频转课程流水线 | 自定义加载（已存在的进程环境变量优先于本文件）                                                       | 用视频转课程功能时 |
| 根目录 `.env`                   | docker compose                | compose 变量替换                                                                                     | 想改 MinIO 账号时  |
| 数据库（drizzle）               | 数据库                        | 复用 `DATABASE_URL`（`apps/api/drizzle.config*.ts`、`src/db/migrate.ts`）                            | 无需单独配置       |

## 〇、先启动依赖服务

```bash
pnpm docker:start
```

docker compose 会启动：

- **Postgres**（dev 库）：`localhost:5433`，账号密码 `postgres/password`，库名 `earthworm`
- **Postgres**（test 库）：`localhost:5480`，账号密码 `test/password`，库名 `earthworm_test`
- **MinIO**（对象存储）：API `localhost:9000`，控制台 `localhost:9001`，默认账号密码 `minioadmin/minioadmin`。
  `minio-init` 自动创建私有桶 `earthworm`，并给 `tts/` 前缀配置 30 天过期的生命周期规则（TTS 缓存自动清理）。

MinIO 账号可用根目录 `.env` 的 `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` 覆盖（改了的话，
下面 `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` 也要同步改）。

`docker compose up -d` **不会**启动 Langfuse（它在 `langfuse` profile 里，见 §3.5）。
显式起它时会额外占用：`3002`（UI）+ `127.0.0.1` 上的 `3030`（worker）/ `8124`（ClickHouse HTTP）/
`9095`、`9096`（对象存储与控制台）/ `6380`（Redis）/ `5454`（Postgres）——都避开上面 dev 已用的端口。

首次启动后跑 `pnpm db:init` 建表。

## 一、后端 API（`apps/api/.env`）

| 变量              | 必填  | 默认值   | 用途                                                                                                               |
| ----------------- | ----- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`    | ✅ 是 | 无       | Postgres 连接串，dev 为 `postgres://postgres:password@localhost:5433/earthworm`。迁移（drizzle）与运行时都依赖它。 |
| `SECRET`          | ✅ 是 | 无       | 登录 Cookie 的 HMAC 签名密钥；修改它会使所有已发放的登录凭证失效。                                                 |
| `AUTH_USERNAME`   | ✅ 是 | 无       | 单用户登录的用户名。详见 `README.login.md`。                                                                       |
| `AUTH_PASSWORD`   | ✅ 是 | 无       | 单用户登录的密码。详见 `README.login.md`。                                                                         |
| `NODE_ENV`        | 否    | 空       | dev 留空（读 `.env`）；`test` → `.env.test`，`prod` → `.env.prod`。                                                |
| `PORT`            | 否    | `3001`   | API 监听端口（`main.ts`）。                                                                                        |
| `TTS_PROXY_URL`   | 否    | 空       | 访问 Edge TTS 服务所用 HTTP 代理，如 `http://127.0.0.1:10809`。国内网络访问微软 TTS 时常用。                       |
| `FORGE_REPO_ROOT` | 否    | 自动推断 | 覆盖仓库根目录定位，供 Forge runner 子进程使用。一般无需设置。                                                     |

### 对象存储（S3 协议，dev 用 MinIO）

视频、TTS 缓存、forge JSON 产物全部存对象存储（单桶 + 前缀：`course-video/`、`course-audio/`、`tts/`、`forge/`），
前端通过**预签名 URL 直连**播放。统一走 `@earthworm/storage`（`packages/storage`）。
**dev 下 `S3_*` 全部可省略**，默认值即本地 MinIO：

| 变量                         | 默认值（dev MinIO）     | 用途                                                             |
| ---------------------------- | ----------------------- | ---------------------------------------------------------------- |
| `S3_ENDPOINT`                | `http://localhost:9000` | S3 端点。                                                        |
| `S3_REGION`                  | `us-east-1`             | 区域。MinIO 随意，默认即可。                                     |
| `S3_ACCESS_KEY_ID`           | `minioadmin`            | 访问密钥 ID（改过 MinIO 账号时同步改）。                         |
| `S3_SECRET_ACCESS_KEY`       | `minioadmin`            | 访问密钥 Secret。                                                |
| `S3_BUCKET`                  | `earthworm`             | 桶名，由 compose 的 `minio-init` 自动创建。                      |
| `S3_FORCE_PATH_STYLE`        | `true`                  | MinIO 必须 `true`（path-style）。                                |
| `S3_PRESIGN_EXPIRES_SECONDS` | `21600`（6 小时）       | 预签名 URL 有效期（秒）。过期后前端重新请求 API 即可拿到新 URL。 |

### 最小可用配置（复制 `apps/api/.env.example` 后改这几项）

```
DATABASE_URL="postgres://postgres:password@localhost:5433/earthworm"
SECRET="换成一个长随机字符串"
AUTH_USERNAME="admin"
AUTH_PASSWORD="换成你的密码"
# PORT=3001
# TTS_PROXY_URL="http://127.0.0.1:10809"   # 国内访问 Edge TTS 时再开
# S3_* 全部可省略：默认即 dev MinIO（先 pnpm docker:start）
```

### 测试环境（`apps/api/.env.test`，模板 `.env.test.example`）

`NODE_ENV=test`（跑 e2e / vitest）时读取，需要独立的测试库：

```
DATABASE_URL="postgres://test:password@localhost:5480/earthworm_test"
SECRET="任意随机串"
AUTH_USERNAME="test"
AUTH_PASSWORD="test-password"
```

（e2e 测试用 `AUTH_*` 自动登录，模板默认 `test / test-password`。）

## 二、前端 Client（`apps/client/.env`）

通过 Nuxt `runtimeConfig` 暴露给浏览器，因此**这些值会打包进前端产物，切勿在此放任何密钥**。

| 变量          | 必填  | 默认值            | 用途                                                                                                               |
| ------------- | ----- | ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `API_BASE`    | ✅ 是 | 空                | 后端 API 基址，dev 为 `http://localhost:3001`。前端所有请求（含 `/bili`、`/forge`、`course-pack`）以此为 baseURL。 |
| `ALLOW_FORGE` | 否    | 显示（除非 `=0`） | 是否显示“导入视频”入口。dev 缺省即显示；非 `0` 均视为开启。                                                        |
| `CLARITY`     | 否    | 空                | Microsoft Clarity 统计 tag id。**仅在 `NODE_ENV=production` 构建时注入**，开发环境无效，dev 不用填。               |

最小配置（复制 `apps/client/.env.example`）：

```
API_BASE="http://localhost:3001"
```

> API 的 CORS 白名单写死在 `apps/api/src/main.ts`（`localhost:*` 与 `earthworm.cuixueshe.com(:81)`），
> dev 的 `localhost` 已覆盖，无需改动。

## 三、Course Forge 流水线（`apps/api/.env` 的 FORGE\_\* 段，仅用视频转课程功能时）

用于“视频 → ASR 转写 → LLM 组装课程 → 导入后端”。加载规则：**已在进程中设置的同名环境变量优先于此文件**，本文件只填充未设置的项。
后端发起的流水线子进程自动继承 API 进程的环境变量；只有**手动跑 CLI** 时才需要本文件。

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
| `FORGE_LLM_CONCURRENCY`      | 否     | `10`                           | 一句一调用的并发上限：同时发起多少个句子的模型调用。                                                                                              |
| `FORGE_LLM_PREFLIGHT`        | 否     | `1`                            | 调用前是否预检（连通 / 模型存在 / 显存）。`0` 跳过。                                                                                              |
| `FORGE_LLM_VRAM_STRICT`      | 否     | `1`                            | 显存估算不足时是否直接拦停。`0` 仅警告（接受 CPU 卸载慢跑）。仅本地 ollama/GPU 场景相关。                                                         |
| `FORGE_LLM_VRAM_MARGIN_MB`   | 否     | `512`                          | 显存估算余量（MB，KV cache + CUDA 上下文）。                                                                                                      |

### 3.3 导入后端

| 变量                     | 必填   | 默认值                  | 用途                                                                                                                                    |
| ------------------------ | ------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `FORGE_API_URL`          | 否     | `http://localhost:3001` | 课程导入目标 API 地址。                                                                                                                 |
| `S3_*`（见上文对象存储） | 否     | dev MinIO 默认值        | `forge:import` 把视频上传到 `course-video/<runId>.<ext>`、JSON 产物上传到 `forge/<runId>/`，与 `apps/api/.env` 的 S3 配置保持一致。     |
| `AUTH_USERNAME`          | 视情况 | 空                      | API 单用户登录用户名，`forge:import` 导入前自动登录用；与 `apps/api/.env` 一致。后端发起的流水线子进程自动继承，手动跑 CLI 时才需配置。 |
| `AUTH_PASSWORD`          | 视情况 | 空                      | 同上，登录密码。详见 `README.login.md`。                                                                                                |

### 3.4 流水线运行时变量（由后端自动注入，**无需手动配置**）

后端通过 `runner-client` 以子进程方式跑 `pipeline-runner`，会传入：`FORGE_PHASE`（`transcribe`\|`structure`\|`structure-resolve`）、`FORGE_OUT_DIR`、`FORGE_MEDIA_PATH`、`FORGE_TITLE`、`FORGE_TYPE`（`dialogue`\|`music`）、`FORGE_CLIPS`（`[{start,end}]` JSON）、`FORGE_LANGUAGE`、`FORGE_DESC`。仅在手动跑 CLI/子进程时才需要了解。

### 3.5 编排层开关与追踪调试（可选）

| 变量                           | 必填 | 默认值                            | 用途                                                                                                                    |
| ------------------------------ | ---- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `FORGE_ORCHESTRATOR`           | 否   | `graph`                           | 编排层实现：`graph`（LangGraph `StateGraph`）/ `legacy`（重构前的命令式阶段函数）。改回 `legacy` 即回滚，无需重新构建。 |
| `FORGE_GRAPH_CHECKPOINT_KEEP`  | 否   | `8`                               | 每个任务保留的 checkpoint 份数（含最近的中断态，须 ≥2）；调小可减小 `graph.checkpoint.json`。                           |
| `LANGSMITH_TRACING`            | 否   | `false`                           | 设为 `true` 才把图的节点/LLM 调用上报到 LangSmith（需要 `LANGSMITH_API_KEY`）；只在本机调图时不用开。                   |
| `LANGSMITH_ENDPOINT`           | 否   | `https://api.smith.langchain.com` | LangSmith 域名；EU 区改成 `https://eu.api.smith.langchain.com`。                                                        |
| `LANGSMITH_API_KEY`            | 否   | 空                                | 上报 tracing / 用 Studio 时填。                                                                                         |
| `LANGFUSE_BASE_URL`            | 否   | `https://cloud.langfuse.com`      | 本地自托管填 `http://localhost:3002`（见下）。                                                                          |
| `LANGFUSE_PUBLIC_KEY`          | 否   | 空                                | 与 `LANGFUSE_SECRET_KEY` **同时**有值才启用；任一为空则整条追踪自动关闭（fail-open）。                                  |
| `LANGFUSE_SECRET_KEY`          | 否   | 空                                | 同上。本地自托管栈起好后用 `LANGFUSE_INIT_PROJECT_*` 的默认值。                                                         |
| `LANGFUSE_TRACING`             | 否   | `1`                               | 设 `0` 强制关闭（排障时排除追踪干扰）。                                                                                 |
| `LANGFUSE_TRACING_ENVIRONMENT` | 否   | `development`                     | Langfuse 里的 environment 标签，用来区分本地/线上。                                                                     |

**Langfuse（追踪 LangGraph 图、节点与每次 LLM 调用）**：本地自托管栈已并入根 `docker-compose.yml`，
和 db/minio 一起由 `pnpm docker:start` 拉起，不单独挂 profile：

```bash
pnpm docker:start   # 起 db/minio + langfuse-web/worker/clickhouse/redis/postgres/minio
pnpm docker:stop    # 停
pnpm docker:down    # 删容器（数据卷保留）
```

界面 `http://localhost:3002`（默认 `dev@local.test` / `langfuse1234`）。端口是特意错开的：3000 留给
Nuxt dev，8124/9095/9096/6380/5454 避开 dev 的 minio 与 db。首次启动 ClickHouse 要 1-2 分钟。
`apps/api/.env.example` 里的 `LANGFUSE_PUBLIC_KEY` / `SECRET_KEY` 就是 compose 预置的那对，直接可用。

本地只想调 forge 的图（不需要 DB、OSS 和整个 Nest）：根目录 `pnpm dev:langsmith` 起 LangGraph Studio
（图 API `:2024`，Studio 链接见启动横幅），入口与 Input 示例见 `apps/api/src/forge/core/README.md` §8.2。
注意 Studio 那条链路不接 Langfuse（它自己调 invoke，塞不进 callbacks），看 trace 请跑真实流水线。

### 最小可用配置（在 `apps/api/.env` 的 FORGE\_\* 段填 Key，参考 `.env.example`）

```
FORGE_ASR_API_KEY=sk-你的百炼Key
FORGE_LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
FORGE_LLM_MODEL=tongyi-xiaomi-analysis-flash
FORGE_PREPROCESS_MODEL=qwen3.8-flash
FORGE_LLM_API_KEY=sk-你的百炼Key
FORGE_LLM_REASONING_EFFORT=
FORGE_LLM_ENABLE_THINKING=false
# S3_* 省略时默认 dev MinIO；手动跑 forge:import 且 API 不在本机时按需填写
```

## 四、bilidown CLI（B 站视频下载，可选）

B 站登录已改为 **Web 端扫码、cookie 存服务端数据库**（`bili_cookie` 表），日常使用无需配置任何变量。
只有**手动跑 bilidown CLI 下载**时才需要：

| 变量          | 必填   | 用途                                                                  |
| ------------- | ------ | --------------------------------------------------------------------- |
| `BILI_COOKIE` | 视情况 | 下载携带的 cookie 串（如 `SESSDATA=...; bili_jct=...`）。CLI 不落盘。 |

## 五、遗留 / 未被代码读取的变量（可忽略，无需填写）

- `BACKEND_ENDPOINT`：曾出现在本地 `apps/api/.env`，**代码中无引用**。
- `TTS_STORAGE_DIR` / `COURSE_AUDIO_DIR` / `COURSE_VIDEO_DIR`：本地静态目录方案已删除，代码不再读取（本地 `.env` 里若残留可删除）。
- `HELP_DOCS_URL`：曾在前端使用，现已从 `nuxt.config` 移除、**代码不再读取**。

## 六、安全提醒

- 真实 Key（`FORGE_*_API_KEY`、`S3_SECRET_ACCESS_KEY`、`BILI_COOKIE`）**只放本地 `.env` / 进程环境，绝不提交**（已 gitignore）。
- 前端 `apps/client/.env` 的值会打包进浏览器产物，**禁止放任何密钥**，只放 `API_BASE` 等公开配置。
- 若本地 `apps/api/.env` 里填入的是真实百炼 Key，请注意该 Key 的额度与轮换；如机器共享或曾误传，建议尽快在服务商控制台吊销重发。

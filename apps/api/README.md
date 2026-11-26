# @earthworm/api（后端服务）

Earthworm 的后端 API，基于 **NestJS 10 + Express + Drizzle ORM（Postgres）**。
默认监听 `http://localhost:3001`（`PORT` 可改），无全局路由前缀，Swagger 文档挂在 `/swagger`。

## 快速开始

```bash
# 仓库根目录
pnpm docker:start   # 起 Postgres（db）+ MinIO（自动建私有桶 earthworm）；testdb 不在此列，由 pnpm test 自动启停
pnpm db:init        # 建表
pnpm db:upload      # 首次：导入星荣课程
pnpm dev:serve      # 启动后端（watch 模式，自动先构建 schema / storage / game-data-sdk）
```

配置：复制 `apps/api/.env.example` 为 `apps/api/.env`。

| 变量                 | 用途                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`       | Postgres 连接串                                                                                                   |
| `SECRET`             | 签名密钥                                                                                                          |
| `PORT`               | 监听端口，默认 3001                                                                                               |
| `S3_*`               | 对象存储（dev MinIO / prod 阿里云 OSS），见根目录 `README.env.dev.md` 与 `README.env.prod.md`；默认值即 dev MinIO |
| `TTS_PROXY_URL`      | Edge TTS websocket 代理（可选）                                                                                   |
| `FORGE_REPO_ROOT`    | forge 子进程定位 monorepo 根的覆盖项（可选，默认自动向上找）                                                      |
| `FORGE_ORCHESTRATOR` | forge 编排层：`graph`（默认，LangGraph）\| `legacy`（命令式，回滚用）；运行时生效，无需重新构建                   |
| `LANGSMITH_*`        | 可选：`LANGSMITH_TRACING=true` 时把图的节点/LLM 调用上报 LangSmith；本地调图不用配（见下方「调试图」）            |

`NODE_ENV` 决定读哪个 env 文件：`prod` → `.env.prod`，`test` → `.env.test`，否则 `.env`。

## 全局行为

- **启动自检**（`src/common/db.ts`）：连接后校验 6 张必需表（course_packs、statements、course_history、mastered_elements、user_course_progress、user_learning_activities），缺表直接在启动阶段报错并提示 `pnpm docker:start && pnpm db:init`，而不是每个请求都 500。`NODE_ENV=test` 跳过。
- **全局 ValidationPipe + HttpExceptionFilter**：错误统一返回 `{ data: {}, message }`。
- **对象存储**：视频 / TTS 缓存 / forge JSON 产物全部存 S3 协议对象存储（`@earthworm/storage`，dev MinIO / prod 阿里云 OSS），前端通过预签名 URL 直连播放（支持 Range seek）。API 不再挂载 `/course-audio`、`/course-video` 静态目录。
- **CORS 白名单**：`localhost:*` 与 `earthworm.cuixueshe.com(:81)`；JSON body 上限 10mb（课程导入含逐词时间戳）。
- **DB Provider**：`src/global/providers/db.provider.ts` 以 `DB` Symbol 全局注入 drizzle 实例，schema 来自 `@earthworm/schema`。

## 业务模块

| 模块                     | 职责                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `course-pack`            | 课程包 CRUD、学习内容（句子+进度）、完成计数；视频上传（multer 落临时目录 → 传对象存储 `course-video/`，2GB 上限、扩展名白名单）；播放接口把对象键转预签名 URL（`videoIsExternal` 区分外链）                                                                                                                                                                                                                                                                                                         |
| `course-history`         | 课程完成历史查询                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `user-course-progress`   | 最近课程包（limit 钳制 1–3）+ upsert 当前 statement 进度                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `user-learning-activity` | 按日 / 总计学习时长统计与上报                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `mastered-element`       | 已掌握单词的增删查                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `tts`                    | **msedge-tts**（Edge 神经网络语音）：美式 `en-US-AriaNeural` / 英式 `en-GB-SoniaNeural`；sha256(voice\|text) 对象存储缓存 mp3（`tts/` 前缀）、并发去重、SSML 转义；text ≤500 字符                                                                                                                                                                                                                                                                                                                    |
| `tool`                   | `GET /tool/dailySentence` 代理金山词霸每日一句                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `bili`                   | B 站扫码登录（二维码 data URL + 轮询）、视频信息/分 P、后台下载（并发上限 3、可取消）；下载成品上传对象存储后自动调 `ForgeService.createJobFromUploadedVideo` 建流水线任务，本地临时文件用后即删。`bilidown-bridge.ts` 静态 import 内置的 `src/bili/bilidown` 内核                                                                                                                                                                                                                                   |
| `forge`                  | 课程制作流水线 job API：spawn node 跑编译产物 `src/forge/core/pipeline-runner.js` 子进程，stdout 走 JSON Lines 事件协议；子进程内用 LangGraph `StateGraph` 编排（`prepare → transcribe → structureBatch → finalize`，结构化出现失败句时停在 `reviewGate` 的 interrupt 并置 `needs_fix`），续跑靠 `forge/<jobId>/graph.checkpoint.json`；job 存内存 Map（终态 4h 清理）；视频存对象存储，ffmpeg/ASR 用本地临时工作区（阶段结束上传 JSON 产物到 `forge/<jobId>/` 后清理）；单 clip ≤300s、须升序不重叠 |

## 端点一览

| 方法 + 路径                                     | 作用                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| `GET /course-pack`                              | 课程包列表                                                        |
| `POST /course-pack`                             | 创建课程包                                                        |
| `POST /course-pack/video`                       | 上传视频到对象存储，返回 `{ video: 对象键, videoUrl: 预签名URL }` |
| `GET /course-pack/:id`                          | 详情（含完成次数）                                                |
| `GET /course-pack/:id/learning`                 | 句子列表 + 用户进度                                               |
| `GET /course-pack/:id/edit`                     | 编辑表单预填数据                                                  |
| `PATCH /course-pack/:id`                        | 更新元信息并重建句子                                              |
| `DELETE /course-pack/:id`                       | 删除课程包                                                        |
| `POST /course-pack/:id/complete`                | 完成一次学习，累计 completionCount                                |
| `GET /course-history`                           | 全部课程历史                                                      |
| `GET /course-history/:coursePackId`             | 某课程包历史                                                      |
| `GET /user-course-progress/recent-course-packs` | 最近课程包（`?limit=` 1–3）                                       |
| `PUT /user-course-progress`                     | upsert 学习进度                                                   |
| `GET /user-learning-activities`                 | 按日学习时长                                                      |
| `GET /user-learning-activities/total`           | 总学习时长                                                        |
| `POST /user-learning-activities`                | 上报 / upsert 活动时长                                            |
| `POST /mastered-elements`                       | 添加已掌握词                                                      |
| `GET /mastered-elements`                        | 已掌握词列表                                                      |
| `DELETE /mastered-elements/:elementId`          | 移除已掌握词                                                      |
| `GET /tts?text&accent`                          | 返回 mp3 音频流（Edge TTS，带缓存头）                             |
| `GET /tool/dailySentence`                       | 词霸每日一句                                                      |
| `GET /bili/login/status`                        | cookie 登录态                                                     |
| `POST /bili/login/start`                        | 生成登录二维码                                                    |
| `GET /bili/login/poll?key`                      | 轮询扫码结果                                                      |
| `GET /bili/info?url`                            | 视频信息与分 P                                                    |
| `POST /bili/downloads`                          | 发起后台下载，返回 downloadId                                     |
| `GET /bili/downloads/:id`                       | 下载进度（done 附 jobId + 视频预签名 URL）                        |
| `POST /bili/downloads/:id/cancel`               | 取消下载                                                          |
| `POST /forge/jobs`                              | multipart 上传视频 + 建 job（defer 可延后启动）                   |
| `POST /forge/jobs/:id/start`                    | 提交切片区间，启动转写                                            |
| `GET /forge/jobs/:id`                           | 轮询状态（needs_fix 附 structureProgress，done 附 courseJson）    |
| `POST /forge/jobs/:id/resolve`                  | 对失败句提交删除 / 重试决策，续跑结构化 + 对齐                    |
| `DELETE /forge/jobs/:id`                        | 取消 job（杀子进程，幂等）                                        |

## 对象存储（单桶 + 前缀）

持久化文件全部在对象存储（dev: compose MinIO，prod: 阿里云 OSS），桶默认 `earthworm`：

- `course-video/`：上传 / B 站下载 / forge 导入的视频（流水线输入，预签名 URL 播放）
- `course-audio/`：课程音频（保留前缀与读取能力）
- `tts/`：TTS mp3 缓存
- `forge/<jobId>/`：流水线 JSON 产物（meta / transcript / clips / alignment / course / structure.progress / `graph.checkpoint.json`）

ffmpeg/ASR 必需的临时文件在 `os.tmpdir()/earthworm-*` 下，阶段结束即清理；B 站扫码登录的 cookie 持久化在数据库 `bili_cookie` 表（不再写本地文件）。
数据库 `course_packs.video` 存对象键（或外部 URL），播放接口按需转预签名 URL。

清理策略：

- **视频 / forge 产物**：删除课程包时做引用检查，最后一个引用同一视频键的包被删除后，
  级联删除视频对象与 `forge/<id>/`（id = 视频文件名去扩展名）。清理失败仅记 warn 日志，不影响删包。
- **tts/ 缓存**：内容寻址的共享缓存，不参与级联删除，由生命周期规则 30 天过期
  （dev 由 compose `minio-init` 自动配置；prod 在 OSS 控制台配置，见 README.env.prod.md）。

## 调试图（只调 forge 的 LangGraph 编排）

不需要 DB / OSS / 整个 Nest，单独把图加载进 LangGraph Studio，可单步看每步 state、手动 resume interrupt：

```bash
pnpm dev:langsmith    # 根目录；图 API :2024，Studio 链接见启动横幅
```

- 入口 `src/forge/core/graph/dev-entry.ts`（MemorySaver，不写 checkpoint），配置 `apps/api/langgraph.json`。
- 需要 Node ≥ 20.16（`@langchain/langgraph-cli` 的 `engines`）；仓库 `.node-version` 的 20.12.2 低于该值，
  装依赖只会告警，但真正跑 Studio 请用更新的 20.x 或 22。
- 节点仍会真实调 ffmpeg / ASR / LLM，用小素材；Input / Resume 的 JSON 示例见
  `src/forge/core/README.md` §8.2。
- 与 `dev:serve` 的关系：后者是完整业务链路（前端 → Nest → 子进程 → 同一张图），前者只看图本身。

## 测试

`pnpm test`（本地）会自动启停 testdb：`docker-compose --profile test up -d --wait testdb` →
`pnpm db:init:test` 建表 → 跑 unit + e2e → 无论成败 `stop testdb`；CI 上 testdb 由 Actions service 提供，脚本自动跳过启停。
`pnpm docker:start` 不再启动 testdb（它带了 `profiles: ["test"]`，只归测试脚本管）。
单独跑 `test:unit` / `test:e2e` 不经过上述流程，需自己保证 testdb 在跑且 `.env.test` 配置正确（可复制 `.env.test.example`）：

```bash
cd apps/api
pnpm test:unit   # Jest 单测
pnpm test:e2e    # 端对端（连测试库）
pnpm test        # 两者一起
pnpm test:cov    # 覆盖率
```

## 生产

```bash
pnpm build:server   # 根目录：构建 schema + storage + sdk + api
pnpm prod:serve     # pm2 启动（ecosystem.config.js）
```

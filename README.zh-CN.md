# 🐛 Earthworm（蚯蚓英语）

[English](./README.md) | **简体中文**

> 用「连词成句」的打字游戏学英语：把课程视频切成一句一句话，用键盘把中文敲成英文（或听写），边打边听原声。

## ✨ 它能做什么

- **打字式学习游戏**：中译英（默认）与听写两种模式，自绘逐字符输入框 + 打字音效，每句分 Question / Answer 两阶段，实时判分。
- **视频原声跟读**：句子带起止时间戳时，播放会精确 seek 到对应视频片段（支持倍速、重复）；没有视频时回退微软 Edge 神经网络 TTS 发音。
- **课程包管理**：网页端新建 / 编辑课程包，句子列表编辑、JSON 批量导入，视频上传（2GB 上限）。
- **一键「视频 → 课程」（Course Forge）**：上传视频或 B 站扫码下载 → 时间轴打切点 → ASR 词级转写 → LLM 拆分句子并生成中文释义 → 自动入库；有失败句时可逐句「删除 / 重试」，按 checkpoint 续跑（LangGraph 编排，Langfuse / LangSmith 可观测）。
- **学习数据**：学习时长统计与日历热力图、最近课程包、完成历史、已掌握句子。
- **单用户私有部署**：没有注册功能，账号密码写在环境变量里；未登录时全站跳登录页。

## 🧱 技术栈

pnpm monorepo，两个应用 + 四个共享包：

| 目录                        | 说明                                                                    |
| --------------------------- | ----------------------------------------------------------------------- |
| `apps/client`               | 前端：Nuxt 3 纯 SPA（`ssr: false`）+ Vue 3 + Nuxt UI / Tailwind + Pinia |
| `apps/api`                  | 后端：NestJS 10 + Drizzle ORM + Postgres，Swagger 在 `/swagger`         |
| `packages/schema`           | 全部 Drizzle 表定义的单一事实来源                                       |
| `packages/storage`          | S3 协议对象存储封装（dev MinIO / prod 阿里云 OSS）                      |
| `packages/game-data-sdk`    | 课程包写入层（事务写库，含视频时间戳）                                  |
| `packages/xingrong-courses` | 内置示例课程「星荣零基础学英语」与导入脚本                              |

依赖方向大致为 `client → api → game-data-sdk → schema`；视频流水线（forge）、B 站下载内核（bilidown）与数据库迁移都内置在 api 里。

## 🚀 本地启动

**前置条件**：Node.js ≥ 20（CI 用 22.x；前端静态构建请用 `20.12.2`，见 `.node-version`）、pnpm 9（`corepack enable`）、已运行中的 Docker。

> 以下命令都在**仓库根目录**执行。

```bash
# 1. 安装依赖
pnpm install

# 2. 准备环境变量
cp apps/api/.env.example apps/api/.env       # 必填：AUTH_TFGZSDVU / AUTH_PASSWORD / SECRET
cp apps/client/.env.example apps/client/.env # 默认 API_BASE=http://localhost:3001

# 3. 启动 Postgres（5433）+ MinIO（9000 / 控制台 9001）
pnpm docker:start

# 4. 建表（drizzle-kit push）
pnpm db:init

# 5. 导入示例课程（只有首次建库需要）
pnpm db:upload

# 6. 启动后端 http://localhost:3001
pnpm dev:serve

# 7. 另开一个终端启动前端 http://localhost:3000
pnpm dev:client
```

浏览器打开 <http://localhost:3000>，用 `apps/api/.env` 里的 `AUTH_TFGZSDVU` / `AUTH_PASSWORD` 登录。

**常见报错**：`relation "user_course_progress" does not exist` 说明没建表或连错库，按 3 → 4 → 5 → 6 重跑一遍即可（API 启动时也会自检必需表，缺表直接报错提示）。

**可选功能**：

- 「导入视频」流水线需要阿里云百炼 Key（`FORGE_ASR_API_KEY` / `FORGE_LLM_API_KEY`），变量逐项见 [本地开发环境变量](./docs/env/README.env.dev.md)。
- 本地 Langfuse 面板随 `pnpm docker:start` 一起启动：<http://localhost:3002>（`dev@local.test` / `langfuse1234`）。
- 停服务：`pnpm docker:stop`；删容器但保留数据卷：`pnpm docker:down`。

## ☁️ 线上部署

线上是「静态前端 + 单机后端」的组合，媒体文件不进服务器：

```
浏览器 → Cloudflare Pages（Nuxt 静态产物）
       → https://api.<你的域名>（Cloudflare 自动签证书）
       → Cloudflare Tunnel（只要求服务器出站，无需开入站端口）
       → ECS 上的 api 容器（NestJS :3001）+ Postgres 容器
媒体：浏览器用预签名 URL 直连阿里云 OSS
```

| 部分 | 做法                                                       | 命令                 |
| ---- | ---------------------------------------------------------- | -------------------- |
| 前端 | 构建静态产物，Wrangler 直传 Cloudflare Pages               | `pnpm deploy:client` |
| 后端 | 本地跨平台打镜像 → 推阿里云 ACR → SSH 让服务器拉新镜像重启 | `pnpm deploy:serve`  |

首次上云需要一次性准备：ECS（2 核 2G 起、有公网出口）、托管在 Cloudflare 的域名、阿里云 ACR 个人实例、OSS 桶 + RAM AccessKey、Cloudflare Tunnel。**一键命令只更新已有部署，不会帮你建这些资源**，第一次请按文档手动做一遍并验证通过。

生产环境变量（`DATABASE_URL`、`SECRET`、`AUTH_*`、`S3_*` 等）与 OSS 侧前置步骤见 [生产环境变量](./docs/env/README.env.prod.md)；前端 `apps/client/.env.prod` 只放 `API_BASE` 这类公开值（会进浏览器产物，禁放密钥）。

**部署文档**：

- [首次后端部署：ECS / ACR / Cloudflare Tunnel](./docs/deploy/README.backend.md)
- [前端部署：Cloudflare Pages](./docs/deploy/README.frontend.md)
- [日常一键部署与两套 env 的区分](./docs/deploy/README.deploy.md)
- [生产环境变量逐项说明](./docs/env/README.env.prod.md)

## 🧪 测试

提交前请先跑测试。

```bash
pnpm test          # 后端 Jest 单测 + 前端 Vitest
pnpm test:ci       # CI 模式（前端会先起 dev server）
```

前端 E2E：`cd apps/client && pnpm test:e2e:run`（Cypress）。
后端 E2E 需要测试库：`docker compose --profile test up -d` 起 testdb（宿主 5480），并把 `apps/api/.env.test.example` 复制为 `.env.test`。

## 📚 更多文档

| 文档                                                       | 内容                                   |
| ---------------------------------------------------------- | -------------------------------------- |
| [docs/README.instruction.md](./docs/README.instruction.md) | 本地开发端口与默认账号速查             |
| [docs/README.login.md](./docs/README.login.md)             | 单用户登录机制与凭证配置               |
| [docs/env/README.env.dev.md](./docs/env/README.env.dev.md) | 本地开发环境变量逐项说明               |
| [apps/api/README.md](./apps/api/README.md)                 | 后端模块、端点一览、启动自检           |
| [apps/client/README.md](./apps/client/README.md)           | 前端页面、状态管理、播放与 Forge GUI   |
| [AGENTS.md](./AGENTS.md)                                   | 给 AI 编码助手用的代码知识图谱使用说明 |

## 📄 License

[AGPL-3.0](./LICENSE)

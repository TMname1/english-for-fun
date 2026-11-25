# 生产环境环境变量配置（README.env.prod.md）

本文列出**生产部署**需要配置的全部环境变量，以及阿里云 OSS 侧的前置步骤。
本地开发配置见 `README.env.dev.md`；登录凭证说明见 `README.login.md`。

dev 与 prod 共用一套代码，差异全部通过环境变量表达：对象存储从 dev 的 MinIO 换成**阿里云 OSS**。
OSS 原生兼容 S3 协议，代码统一走 `@earthworm/storage`（AWS SDK），**无需改代码**，只改环境变量。

## 一、后端 API（生产环境变量，`NODE_ENV=prod`）

统一模板：[`apps/api/deploy/.env.prod.example`](apps/api/deploy/.env.prod.example)。

- **Docker 部署**（主路径，见 `README.backend.md`）：复制为服务器 `/opt/earthworm/.env.prod`，由 compose `env_file` 注入 api 容器；`NODE_ENV=prod` / `PORT=3001` 镜像已内置。
- **非容器运行**（pm2 / 服务器上手动跑 forge CLI）：复制为 `apps/api/.env.prod`，进程环境设 `NODE_ENV=prod`，NestJS `ConfigModule` 与 forge 均读该文件（已 gitignore，不提交）。

| 变量            | 必填  | 生产取值                            | 说明                                                                          |
| --------------- | ----- | ----------------------------------- | ----------------------------------------------------------------------------- |
| `NODE_ENV`      | ✅ 是 | `prod`                              | 在进程环境（pm2 / systemd / shell）中设置，决定读 `.env.prod`。               |
| `DATABASE_URL`  | ✅ 是 | 生产 Postgres 连接串                | 首次部署先跑 `pnpm db:init` 建表。                                            |
| `SECRET`        | ✅ 是 | **强随机串**（不要沿用 dev 示例值） | 登录 Cookie 的 HMAC 签名密钥，泄露可伪造登录 Cookie；修改会使已发放凭证失效。 |
| `AUTH_USERNAME` | ✅ 是 | 生产用户名                          | 单用户登录，详见 `README.login.md`。                                          |
| `AUTH_PASSWORD` | ✅ 是 | **强密码**                          | 同上。                                                                        |
| `PORT`          | 否    | 按需（默认 `3001`）                 | pm2 / 反代上游端口。                                                          |
| `TTS_PROXY_URL` | 否    | 服务器能直连 Edge TTS 就留空        | 访问微软 TTS 的 HTTP 代理。                                                   |

### 对象存储：阿里云 OSS（`S3_*`）

只需配一处（Docker 部署为 `/opt/earthworm/.env.prod`，非容器为 `apps/api/.env.prod`；forge 子进程自动继承，CLI 共用该文件）。
**生产没有默认值兜底可用，`S3_*` 必须显式填写**（代码默认值面向 dev MinIO）：

| 变量                         | 生产取值                               | 说明                                                                                      |
| ---------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `S3_ENDPOINT`                | `https://oss-cn-<region>.aliyuncs.com` | OSS 的 **S3 兼容端点**，如 `https://oss-cn-hangzhou.aliyuncs.com`。不要填管理控制台地址。 |
| `S3_REGION`                  | `oss-cn-<region>`                      | 如 `oss-cn-hangzhou`、`oss-cn-shanghai`，与端点一致。                                     |
| `S3_ACCESS_KEY_ID`           | RAM 子账号 AccessKey ID                | 见下文「RAM 授权」。                                                                      |
| `S3_SECRET_ACCESS_KEY`       | RAM 子账号 AccessKey Secret            | 只放服务端 `.env.prod`，绝不进前端或仓库。                                                |
| `S3_BUCKET`                  | 你在 OSS 控制台创建的桶名              | 桶需与端点同地域。                                                                        |
| `S3_FORCE_PATH_STYLE`        | **`false`**                            | OSS 用虚拟主机风格（`<bucket>.<endpoint>`）。填 `true` 会 404/签名错误。                  |
| `S3_PRESIGN_EXPIRES_SECONDS` | 按需，如 `21600`（6 小时，可省略）     | 预签名 URL 有效期。过期后前端重新请求 API 自动换新 URL，无需人工干预。                    |

### OSS 侧前置步骤

1. **建桶**：OSS 控制台创建桶（如 `earthworm`），地域与 `S3_REGION` 一致，**读写权限选「私有」**。
   所有对象都通过预签名 URL 访问，不要开公共读。
2. **RAM 子账号**：创建 RAM 用户并生成 AccessKey，授予该桶的读写权限（系统策略 `AliyunOSSFullAccess`
   可用但偏大；推荐自定义策略限定 `acs:oss:*:*:<bucket>` 与 `acs:oss:*:*:<bucket>/*` 的
   `oss:GetObject` / `oss:PutObject` / `oss:DeleteObject` / `oss:ListObjects` / `oss:AbortMultipartUpload`）。
3. **CORS（可选）**：`<video src>` / `<audio src>` 播放预签名 URL **不需要** CORS。
   只有当前端用 `fetch()` 直接读对象内容时才需要在桶的「跨域设置」里放行站点来源（GET、允许头 `*`）。
4. **网络**：服务器与 OSS 同地域时可改用内网端点 `https://oss-cn-<region>-internal.aliyuncs.com`
   省流量费；但**预签名 URL 的 host 也会变成内网域名，浏览器无法访问**——只要前端要直连播放，
   `S3_ENDPOINT` 必须用公网端点。
5. **生命周期规则（TTS 缓存清理）**：OSS 控制台 → 桶 → 基础设置 → 生命周期 → 创建规则：
   前缀 `tts/`，「文件最后一次修改时间 30 天后」删除文件。TTS 缓存是共享的内容寻址缓存，
   删课程包不会级联删它，靠此规则自动过期。这是控制台一次性配置，不走 `S3_*` 环境变量
   （dev 侧由 compose 的 `minio-init` 自动配置等价规则）。

### 对象键布局（与 dev 一致）

| 前缀                   | 内容                                  |
| ---------------------- | ------------------------------------- |
| `course-video/<name>`  | 上传 / B 站下载 / CLI 导入的课程视频  |
| `course-audio/<name>`  | 课程音频（保留前缀）                  |
| `tts/<sha256>.mp3`     | TTS 缓存                              |
| `forge/<jobId>/*.json` | 流水线产物（meta/transcript/course…） |

数据库 `course_packs.video` 存**对象键**（或外部 http URL），不存预签名 URL；API 在播放接口里按需签名。

**删除语义**：删除课程包时，API 会检查是否还有其他包引用同一视频键；最后一个引用被删除时
级联删除视频对象及 `forge/<id>/` 产物（id = 视频文件名去扩展名）。清理失败只记告警、不影响删包结果。
`tts/` 缓存不参与级联，由生命周期规则 30 天过期。

### `.env.prod` 示例

```
DATABASE_URL="postgres://用户:密码@生产数据库地址:5432/earthworm"
SECRET="换成一个强随机字符串"
AUTH_USERNAME="生产用户名"
AUTH_PASSWORD="换成强密码"
# PORT=3001
# TTS_PROXY_URL=""   # 服务器能直连 Edge TTS 就留空

S3_ENDPOINT="https://oss-cn-hangzhou.aliyuncs.com"
S3_REGION="oss-cn-hangzhou"
S3_ACCESS_KEY_ID="RAM子账号AccessKeyID"
S3_SECRET_ACCESS_KEY="RAM子账号AccessKeySecret"
S3_BUCKET="你的桶名"
S3_FORCE_PATH_STYLE="false"
S3_PRESIGN_EXPIRES_SECONDS="21600"
```

## 二、前端 Client（`apps/client/.env.prod`，构建时注入）

生产构建链 `pnpm build:client` → `nuxt generate --dotenv .env.prod` 读取该文件（模板 `.env.prod.example`）。
值会打包进浏览器产物，**禁放任何密钥**。

| 变量          | 必填  | 生产取值                                              | 说明                                          |
| ------------- | ----- | ----------------------------------------------------- | --------------------------------------------- |
| `API_BASE`    | ✅ 是 | 生产 API 地址，如 `http://earthworm.cuixueshe.com:81` | 前端所有请求的 baseURL。                      |
| `ALLOW_FORGE` | 否    | 建议 `0`                                              | 生产关闭「导入视频」入口；非 `0` 均视为开启。 |
| `CLARITY`     | 否    | 按需填统计 tag id                                     | 仅在 `NODE_ENV=production` 构建时注入。       |
| `NODE_ENV`    | 否    | `production`（生产构建）                              | `production` 才会注入 Clarity。               |

> 注意：API 的 CORS 白名单写死在 `apps/api/src/main.ts`
> （`localhost:*`、`earthworm.cuixueshe.com(:81)` 与 `https://bananablog.cc`）。**换域名需同步改这里的正则**。
> 媒体走预签名 URL 直连 OSS，不受 API CORS 限制。

## 三、Course Forge（`apps/api/.env.prod` 的 FORGE\_\* 段）

后端发起的流水线子进程自动继承 API 进程的环境变量，**无需单独配置**。
在生产服务器上手动跑 CLI（如 `forge:import`）时读的也是同一文件：

| 变量                           | 生产取值                                | 说明                                                                                               |
| ------------------------------ | --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `FORGE_API_URL`                | 生产 API 地址                           | 课程导入目标。                                                                                     |
| `AUTH_*`                       | 与生产 API 一致                         | 导入前自动登录用。                                                                                 |
| `S3_*`                         | 与上文 OSS 配置一致                     | 视频与 JSON 产物上传目标。                                                                         |
| `FORGE_ASR_*` / `FORGE_LLM_*`  | 同 dev（见 `README.env.dev.md` 第三节） | ASR / LLM 的 Key 与模型配置。                                                                      |
| `FORGE_ORCHESTRATOR`           | 不填（默认 `graph`）                    | 编排层实现；线上排障时可临时设 `legacy` 回滚到命令式实现，改完重启进程即生效，无需重新构建镜像。   |
| `LANGSMITH_*`                  | 不填                                    | 仅当需要把线上跑图/LLM 调用上报 LangSmith 时填（`LANGSMITH_TRACING=true` + `LANGSMITH_API_KEY`）。 |
| `LANGFUSE_PUBLIC_KEY`          | Langfuse Cloud 项目的 pk                | 追踪 LangGraph 图/节点/每次 LLM 调用。与 `LANGFUSE_SECRET_KEY` 同时有值才启用。                    |
| `LANGFUSE_SECRET_KEY`          | 对应的 sk                               | 任一为空 = 关闭追踪（fail-open，不影响流水线）。                                                   |
| `LANGFUSE_BASE_URL`            | `https://cloud.langfuse.com`            | 线上**不自托管**，直连 Langfuse Cloud。                                                            |
| `LANGFUSE_TRACING_ENVIRONMENT` | `production`                            | 用来在 Langfuse 里把线上与本地 trace 分开。                                                        |

> **为什么线上不自托管 Langfuse**：完整栈（web/worker/ClickHouse/Postgres/Redis/MinIO）官方单机建议
> 4 核 16G，精简后仍需额外 ~1.9G 常驻内存，当前 2 核 2G 的 ECS 放不下。走 Cloud 只需容器能**出站**
> 访问 `443`，安全组入方向保持只开 22 不变，`apps/api/deploy/docker-compose.yml` 无需任何改动。

## 四、不需要部署 / 配置的项

- **MinIO 相关服务**（`minio` / `minio-init`）只用于 dev，prod 不需要部署。
- **B 站 cookie**：存服务端数据库（`bili_cookie` 表），Web 端扫码登录写入，无需环境变量。
  `BILI_COOKIE` 仅供手动跑 bilidown CLI 时使用。
- **测试库**（`.env.test`）：仅跑测试时需要，生产运行不涉及。

## 五、部署后冒烟清单

1. 管理页上传一个视频 → OSS 控制台出现 `course-video/<name>` → 创建课程包 → 学习页可播放、可 seek。
2. TTS 发音一次 → OSS 出现 `tts/<hash>.mp3`，第二次请求命中缓存。
3. （若开启 forge）上传 → 切片 → 转写 → 结构化（有失败句时前端 resolve）→ 入库，OSS 出现 `forge/<jobId>/*.json`（含 `graph.checkpoint.json`）。
4. 服务器本地临时目录（`os.tmpdir()/earthworm-*`）任务结束后无残留。
5. 删除一个课程包 → OSS 控制台对应 `course-video/<name>` 与 `forge/<id>/` 消失（若无其他包引用该视频）。

## 六、已知边界

- **存量数据不迁移**：旧库里指向 `/course-video/...` 本地路径的记录在 prod 会失效（方案已确认接受）；
  如需保留旧课程，把对应文件手工上传到 OSS 并把 `course_packs.video` 更新为对象键即可。
- 预签名 URL 在有效期内「持链接即可访问」，这是直连方案的固有语义；桶保持私有、有效期按需调短。

## 七、安全提醒

- `SECRET`、`AUTH_PASSWORD`、`S3_SECRET_ACCESS_KEY`、`FORGE_*_API_KEY` **只放服务端 `.env.prod`，绝不提交**（已 gitignore）。
- 前端 `apps/client/.env.prod` 的值会进浏览器产物，只放 `API_BASE` 等公开配置。
- OSS 桶保持私有，RAM 子账号按最小权限授权（见上文）。

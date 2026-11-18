# dev → prod 环境变量改动清单（README.devToProd.md）

本项目 dev 与 prod 共用一套代码，差异全部通过环境变量表达。本文列出从本地开发切换到生产部署
（对象存储从 MinIO 换成**阿里云 OSS**）时需要改动的每一项，以及 OSS 侧的前置步骤。

各变量的完整说明见 `README.env.md`；登录凭证见 `README.login.md`。

## 一、对象存储：MinIO → 阿里云 OSS

阿里云 OSS 原生兼容 S3 协议，代码统一走 `@earthworm/storage`（AWS SDK），**无需改代码**，只改环境变量。
`apps/api/.env`（或 `.env.prod`）与 `packages/course-forge/.env` 两处都要改，且保持一致。

| 变量                         | dev（MinIO）                  | prod（阿里云 OSS）                     | 说明                                                                                                        |
| ---------------------------- | ----------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `S3_ENDPOINT`                | `http://localhost:9000`       | `https://oss-cn-<region>.aliyuncs.com` | OSS 的 **S3 兼容端点**，如 `https://oss-cn-hangzhou.aliyuncs.com`。不要填 OSS 原生 API 域名以外的管理地址。 |
| `S3_REGION`                  | `us-east-1`                   | `oss-cn-<region>`                      | 如 `oss-cn-hangzhou`、`oss-cn-shanghai`，与端点一致。                                                       |
| `S3_ACCESS_KEY_ID`           | `minioadmin`                  | RAM 子账号 AccessKey ID                | 见下文「RAM 授权」。                                                                                        |
| `S3_SECRET_ACCESS_KEY`       | `minioadmin`                  | RAM 子账号 AccessKey Secret            | 只放服务端 `.env`，绝不进前端或仓库。                                                                       |
| `S3_BUCKET`                  | `earthworm`（compose 自动建） | 你在 OSS 控制台创建的桶名              | 桶需与端点同地域。                                                                                          |
| `S3_FORCE_PATH_STYLE`        | `true`                        | **`false`**                            | MinIO 用 path-style；OSS 用虚拟主机风格（`<bucket>.<endpoint>`）。填错会 404/签名错误。                     |
| `S3_PRESIGN_EXPIRES_SECONDS` | `21600`（6 小时，可省略）     | 按需，如 `21600`                       | 预签名 URL 有效期。过期后前端重新请求 API 自动换新 URL，无需人工干预。                                      |

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
   删课程包不会级联删它，靠此规则自动过期。这是控制台一次性配置，不走 `S3_*` 环境变量；
   dev 侧由 compose 的 `minio-init` 自动配置等价规则。

### 对象键布局（两环境一致）

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

## 二、其余部署相关变量

### `apps/api/.env`（prod 用 `.env.prod`，`NODE_ENV=prod`）

| 变量            | dev                                                     | prod                                             |
| --------------- | ------------------------------------------------------- | ------------------------------------------------ |
| `NODE_ENV`      | 空                                                      | `prod`（改读 `.env.prod`）                       |
| `DATABASE_URL`  | `postgres://postgres:password@localhost:5433/earthworm` | 生产 Postgres 连接串（先跑 `pnpm db:init` 建表） |
| `SECRET`        | 示例随机串                                              | **换一个强随机串**（泄露可伪造登录 Cookie）      |
| `AUTH_USERNAME` | `admin`                                                 | 生产用户名                                       |
| `AUTH_PASSWORD` | `change-me`                                             | **强密码**                                       |
| `PORT`          | `3001`                                                  | 按需（pm2 / 反代上游端口）                       |
| `TTS_PROXY_URL` | 视网络                                                  | 服务器能直连 Edge TTS 就留空                     |

### `apps/client/.env`（构建时注入，值会进浏览器产物，禁放密钥）

| 变量          | dev                     | prod                                                  |
| ------------- | ----------------------- | ----------------------------------------------------- |
| `API_BASE`    | `http://localhost:3001` | 生产 API 地址，如 `http://earthworm.cuixueshe.com:81` |
| `ALLOW_FORGE` | 缺省（显示）            | 建议 `0`（生产关闭「导入视频」入口）                  |
| `CLARITY`     | 空                      | 按需填统计 tag id                                     |

> 注意：API 的 CORS 白名单写死在 `apps/api/src/main.ts`
> （`localhost:*` 与 `earthworm.cuixueshe.com(:81)`）。换域名需同步改这里的正则。
> 媒体走预签名 URL 直连 OSS，不受 API CORS 限制。

### `packages/course-forge/.env`（仅 CLI 手动跑时需要）

| 变量            | dev                     | prod                      |
| --------------- | ----------------------- | ------------------------- |
| `FORGE_API_URL` | `http://localhost:3001` | 生产 API 地址             |
| `AUTH_*`        | 与 API 一致             | 与生产 API 一致           |
| `S3_*`          | 同上表                  | 同上表（与 API 保持一致） |

后端发起的流水线子进程自动继承 API 进程的环境变量，无需单独配置。

## 三、部署后冒烟清单

1. 管理页上传一个视频 → OSS 控制台出现 `course-video/<name>` → 创建课程包 → 学习页可播放、可 seek。
2. TTS 发音一次 → OSS 出现 `tts/<hash>.mp3`，第二次请求命中缓存。
3. （若开启 forge）上传 → 切片 → 转写 → 校对 → 入库，OSS 出现 `forge/<jobId>/*.json`。
4. 服务器本地临时目录（`os.tmpdir()/earthworm-*`）任务结束后无残留。
5. 删除一个课程包 → OSS 控制台对应 `course-video/<name>` 与 `forge/<id>/` 消失（若无其他包引用该视频）。

## 四、已知边界

- **存量数据不迁移**：旧库里指向 `/course-video/...` 本地路径的记录在 prod 会失效（方案已确认接受）；
  如需保留旧课程，把对应文件手工上传到 OSS 并把 `course_packs.video` 更新为对象键即可。
- 预签名 URL 在有效期内「持链接即可访问」，这是直连方案的固有语义；桶保持私有、有效期按需调短。
- MinIO 相关服务（`minio` / `minio-init`）只用于 dev，prod 不需要部署。

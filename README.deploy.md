# 一键部署指南（README.deploy.md）

本文件讲**日常一键部署**怎么跑，命令封装在 `scripts/backend-deploy.ts`（后端）与 `wrangler`（前端）。

> ⚠️ **运行任何一键部署命令之前，先确保你已经「手动成功部署过一次」。**
> 首次上云请按 [README.backend.md](README.backend.md)（服务器初始化、ACR、Cloudflare Tunnel、`/opt/earthworm` 的 env 配置）和 [README.frontend.md](README.frontend.md)（CF Pages、域名、`_redirects`）逐项做完并验证通过。
> 一键脚本**只负责"更新已存在的部署"**，不会帮你建服务器、配 Tunnel、装 Docker、创建 ACR 仓库或 CF Pages 项目。这些一次性配置错任何一项，一键命令都会在某个步骤上莫名其妙失败。

---

## 一、前端：`pnpm deploy:client`

构建静态产物并用 `wrangler` 部署到 Cloudflare Pages：

```bash
pnpm deploy:client
# = pnpm build:client && wrangler pages deploy apps/client/.output/public --project-name english-for-fun
```

- 前端**只打静态包，不打镜像**，纯走 CF Pages。
- 构建时注入的环境变量在 `apps/client/.env.prod`（模板 `.env.prod.example`），值会进浏览器产物，**禁放任何密钥**。详见 [README.env.prod.md](README.env.prod.md) 第二节。

> ⚠️ **即使前端代码没有任何改动，跑一次 `deploy:client` 也会让 Cloudflare 产生一个全新的 deployment**（占用 deployment 配额、触发一次新的预览/生产发布）。**前端没改就别随手运行这条命令。**

---

## 二、后端：`pnpm deploy:serve`

一条命令完成"本地构建镜像 → 推阿里云 ACR → 上传配置到服务器 → 服务器拉新镜像重启"。

```bash
pnpm deploy:serve
# = tsx --env-file=scripts/.env.prod scripts/backend-deploy.ts
```

脚本等价于依次执行下列步骤（第 5-9 步通过 SSH 在云服务器上跑）：

1. **本地构建镜像**（必须 `linux/amd64`，服务器是 x86）：
   ```bash
   docker build --platform linux/amd64 -f apps/api/Dockerfile -t earthworm-api:local .
   ```
2. **打 tag**：`v1-<最后一条 git 短哈希>`，例如 `v1-9f3a2c1`，推到阿里云 ACR：
   ```bash
   docker tag earthworm-api:local registry.cn-hangzhou.aliyuncs.com/<命名空间>/earthworm-api:v1-<hash>
   ```
3. **本地登录 ACR**（密码走 stdin，不进命令行历史）：
   ```bash
   echo '<密码>' | docker login --username=<阿里云账号全名> --password-stdin registry.cn-hangzhou.aliyuncs.com
   ```
4. **推送镜像**（每次都是唯一 tag，便于回滚）：
   ```bash
   docker push registry.cn-hangzhou.aliyuncs.com/<命名空间>/earthworm-api:v1-<hash>
   ```
5. **SSH 连服务器，覆盖 `/opt/earthworm` 下的变量文件**——上传 `docker-compose.yml`、`.env.prod`，并把 `.env` 里的 `API_IMAGE` 改成本次的新 tag 后上传（`.env.prod` 含真实密钥，本地 `apps/api/deploy/.env*` 是 source of truth，见下文环境变量说明）。
6. **服务器登录 ACR**（私有仓库 pull 需要）：
   ```bash
   echo '<密码>' | docker login --username=<阿里云账号全名> --password-stdin registry.cn-hangzhou.aliyuncs.com
   ```
7. **进入部署目录**：`cd /opt/earthworm`
8. **拉取新镜像**：`docker compose pull`（按 `.env` 的新 `API_IMAGE` 拉本次 tag）
9. **重启服务**：`docker compose up -d`（迁移随容器启动自动幂等执行）

> 回滚：把 `scripts/.env.prod` 的 `IMAGE_TAG_PREFIX` / 或直接改服务器 `.env` 的 `API_IMAGE` 指回旧 tag，再单独在服务器 `docker compose pull && up -d`。因为每次 tag 唯一，旧镜像一直在 ACR 里。

---

## 三、环境变量说明

后端一键部署有两组 env，**别混淆**：

### 1）`scripts/.env.prod` —— 给部署脚本本身用（本地，不进仓库）

模板 [`scripts/.env.prod.example`](scripts/.env.prod.example)。复制为 `scripts/.env.prod` 后填写，`pnpm deploy:serve` 通过 `--env-file` 读取。它决定"推到哪、怎么连服务器"：

| 变量               | 说明                                                                         |
| ------------------ | ---------------------------------------------------------------------------- |
| `ACR_REGISTRY`     | 镜像仓库域名，默认杭州 `registry.cn-hangzhou.aliyuncs.com`，换地域要同步改。 |
| `ACR_NAMESPACE`    | ACR 命名空间。                                                               |
| `ACR_USERNAME`     | 阿里云**账号全名**（不是 AccessKey，也不是登录密码）。                       |
| `ACR_PASSWORD`     | ACR **访问凭证密码**（专用，非阿里云登录密码）。                             |
| `IMAGE_NAME`       | 仓库名，默认 `earthworm-api`。                                               |
| `IMAGE_TAG_PREFIX` | tag 前缀，默认 `v1`；实际推 `v1-<git短哈希>`。                               |
| `SSH_HOST`         | 服务器公网 IP / 域名。                                                       |
| `SSH_PORT`         | SSH 端口，默认 `22`。                                                        |
| `SSH_USER`         | SSH 登录用户名。                                                             |
| `SSH_PASSWORD`     | SSH 登录密码。                                                               |
| `REMOTE_DIR`       | 服务器部署目录，默认 `/opt/earthworm`。                                      |

### 2）`apps/api/deploy/.env` 与 `.env.prod` —— 给服务器上的容器用（脚本会上传覆盖）

这两个是**应用运行时配置**，脚本第 5 步把它们 scp 到 `/opt/earthworm/`：

- `apps/api/deploy/.env`：compose 插值用，含 `API_IMAGE`（脚本自动改写为新 tag）和 `POSTGRES_PASSWORD`。**本地这一份的 `POSTGRES_PASSWORD` 必须和 `.env.prod` 里 `DATABASE_URL` 的密码一致**，否则 api 连不上库反复重启。
- `apps/api/deploy/.env.prod`：api 容器运行时变量（`DATABASE_URL`、`SECRET`、`AUTH_*`、`S3_*`、`FORGE_*`）。逐项含义见 [README.env.prod.md](README.env.prod.md)。

> 因为脚本第 5 步**整份覆盖**服务器上这三个文件，所以**本地 `apps/api/deploy/.env` 和 `.env.prod` 就是唯一真相**：要改服务器配置（换密钥、改 DB、调 OSS），先改本地这两个文件再 `deploy:serve`，不要只在服务器上 `vi`，否则下次一键部署会被本地覆盖回去。

---

## 四、安全提醒

- `scripts/.env.prod`、`apps/api/deploy/.env`、`apps/api/deploy/.env.prod` 含密码/密钥/私钥级凭证，均已被 `.gitignore` 忽略，**绝不提交**。
- `SSH_PASSWORD`、`ACR_PASSWORD` 只放本地 `scripts/.env.prod`；脚本走 stdin / SFTP 传输，不会写进服务器命令历史。
- 一键部署会覆盖服务器配置，确认本地 env 无误再跑；不确定就先备份服务器 `/opt/earthworm` 再执行。

## 五、相关文档

- 首次手动部署 / 架构 / 排障：[README.backend.md](README.backend.md)
- 前端构建与 CF Pages：[README.frontend.md](README.frontend.md)
- 生产环境变量逐项说明：[README.env.prod.md](README.env.prod.md)

# 后端部署操作指南（README.backend.md）

把 `apps/api` 部署到阿里云轻量服务器（2核2G，Docker 应用镜像），通过 Cloudflare Tunnel 对外提供 `https://api.你的域名`。

完整细节（故障排查、运维、swap）见 [apps/api/DEPLOY.md](apps/api/DEPLOY.md)；环境变量逐项说明见 [README.env.prod.md](README.env.prod.md)。

## 架构与原理

```
浏览器 → https://你的域名（CF Pages 前端）
       → https://api.你的域名（CF 自动签证书）
       → Cloudflare Tunnel（出站连接，服务器无需开任何入站端口）
       → 服务器 cloudflared 容器（host 网络）
       → 127.0.0.1:3001 api 容器（NestJS）
       → pg 容器（Postgres 16，仅 docker 内网，数据挂卷）
媒体文件走 OSS 预签名 URL 直连，不经过 api。
```

要点：

- **构建全程在本地**：Docker Desktop 在本机提供 Linux 构建环境，产出完整镜像（含 dist、生产依赖、drizzle 迁移、linux 版 ffmpeg）。服务器只 `docker pull` 运行成品，不装 pnpm、不编译、不接触源码。
- **不能只上传 dist**：NestJS 是 tsc 编译，dist 非自包含，必须连同 Linux 版 node_modules 一起打包，这正是 Dockerfile 做的事。
- 内存预算：api ≤1G、pg ≤512M、cloudflared ~30M。

## 前置条件

- 阿里云轻量服务器，**应用镜像选 Docker**（预装 Docker；选普通 Linux 镜像则需自装）
- 域名 `你的域名` 托管 Cloudflare，前端已上 CF Pages
- OSS 桶 + RAM AccessKey、百炼 Key：按 [README.env.prod.md](README.env.prod.md) 完成
- 本地 Windows 装好 Docker Desktop 并启动

## 第 1 步：开通阿里云 ACR（镜像仓库，免费）

控制台 → 容器镜像服务 → **个人实例**：

1. 设置访问密码（push/pull 登录用，不是阿里云登录密码）
2. 创建命名空间（如 `my-ns`）
3. 创建**私有**仓库 `earthworm-api`
4. **地域选与轻量服务器相同**（下文以 cn-hangzhou 为例）

## 第 2 步：本地构建镜像（仓库根执行）

国内 Docker Hub 通常不可达，先准备基础镜像（二选一）：

```bash
# 方式 A：手动拉取并改名
docker pull docker.m.daocloud.io/library/node:20-bookworm-slim
docker tag docker.m.daocloud.io/library/node:20-bookworm-slim node:20-bookworm-slim

# 方式 B：Docker Desktop → Settings → Docker Engine 加 mirror 后 Apply & Restart
#   { "registry-mirrors": ["https://docker.m.daocloud.io"] }
```

构建（首次约几分钟，产出约 500MB）：

```bash
docker build --platform linux/amd64 -f apps/api/Dockerfile -t earthworm-api:local .
```

Dockerfile 内置 8 项产物自检（入口/迁移/forge/ffmpeg/三个 workspace 包），缺任何一项构建当场失败。
ffmpeg-static 从 GitHub 下载二进制若超时：给 Docker Desktop 配代理，或在 Dockerfile builder 段临时加
`ENV FFMPEG_BINARIES_URL=https://registry.npmmirror.com/-/binary/ffmpeg-static`。

## 第 3 步：推送镜像到 ACR

```bash
docker tag earthworm-api:local registry.cn-hangzhou.aliyuncs.com/<命名空间>/earthworm-api:v1
docker login --username=<阿里云账号全名> registry.cn-hangzhou.aliyuncs.com
docker push registry.cn-hangzhou.aliyuncs.com/<命名空间>/earthworm-api:v1
```

## 第 4 步：服务器初始化

SSH 登录服务器：

```bash
docker compose version        # Docker 应用镜像一般预装；缺则 apt-get install docker-compose-plugin
mkdir -p /opt/earthworm
```

1. **配镜像加速**（拉 postgres/cloudflared 用）：编辑 `/etc/docker/daemon.json`：
   ```json
   { "registry-mirrors": ["https://docker.m.daocloud.io"] }
   ```
   然后 `systemctl restart docker`。
2. 把 `apps/api/deploy/` 的三个文件上传到 `/opt/earthworm/`：
   `docker-compose.yml`、`.env.example`、`.env.prod.example`
3. 填写环境变量：
   ```bash
   cd /opt/earthworm
   cp .env.example .env
   cp .env.prod.example .env.prod
   chmod 600 .env .env.prod
   ```
   - `.env`：`API_IMAGE`（第 3 步的完整镜像地址）、`POSTGRES_PASSWORD`（自定义强密码）、`CLOUDFLARE_TUNNEL_TOKEN`（第 5 步获得）
   - `.env.prod`：`DATABASE_URL`（密码**必须与 `.env` 一致**，主机名保持 `pg`）、`SECRET`（`openssl rand -hex 32` 生成）、`AUTH_USERNAME/AUTH_PASSWORD`、`S3_*`（OSS 生产值）、`FORGE_*`（百炼 Key）
4. 登录 ACR（私有仓库 pull 需要）：
   ```bash
   docker login --username=<阿里云账号全名> registry.cn-hangzhou.aliyuncs.com
   ```
5. **防火墙**：阿里云轻量防火墙入方向**只留 SSH（22）**，不开 3001/5432。

## 第 5 步：创建 Cloudflare Tunnel

1. CF 面板 → **Zero Trust → Networks → Tunnels → Create a tunnel** → 选 **Cloudflared** → 命名 `earthworm-api`
2. 页面给出安装命令（`cloudflared service install eyJ...`）——**不要执行它**。我们用容器跑 cloudflared：把 `eyJ...` 整串 token 填到服务器 `/opt/earthworm/.env` 的 `CLOUDFLARE_TUNNEL_TOKEN`
3. **Public hostname**：Subdomain `api`，Domain `你的域名`；Service **HTTP**，URL `localhost:3001`；保存
4. CF 自动建 DNS CNAME 并签证书，无需手动 A 记录

> compose 里 cloudflared 是 host 网络，所以 `localhost:3001` 直达 api。若日后改成 bridge 网络，Service URL 必须改 `http://api:3001`。

## 第 6 步：启动与验证

```bash
cd /opt/earthworm
docker compose pull
docker compose up -d
docker compose logs -f api    # 看到 "Woohoo! Migrations completed!" 后 Nest 启动
```

迁移每次启动自动跑（幂等）。验证清单：

```bash
docker compose ps                                        # pg/api healthy，cloudflared Up
curl -i http://127.0.0.1:3001/auth/me                    # 401 JSON = 正常（无 health 路由）
curl -i -X POST http://127.0.0.1:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"<用户名>","password":"<密码>"}'        # 201 + Set-Cookie
curl -i https://api.你的域名/auth/me                # 401 = CF 链路通
```

最后浏览器打开 `https://你的域名` 登录、上传音频、TTS 发音各试一次。

> 浏览器必须走 https 域名登录（prod Cookie 是 `Secure; SameSite=None`）；`*.pages.dev` 预览域名不在 CORS 白名单，属已知现状。

## 日常更新与回滚

```bash
# 本地：改代码 → 重新 build → push 新 tag（如 v2）
# 服务器：
cd /opt/earthworm
vi .env                          # API_IMAGE 改新 tag
docker compose pull api && docker compose up -d api
```

回滚：`API_IMAGE` 改回旧 tag 再 `pull api && up -d api`。

## 常见问题速查

| 现象                       | 处理                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------- |
| api 反复重启               | `docker compose logs api`：迁移失败查 DATABASE_URL / pg 状态                          |
| CF 502 / Error 1033        | 查 tunnel token、Service URL 是否 `localhost:3001`、cloudflared 是否 Up               |
| 浏览器登录不上但 curl 正常 | 必须走 https 域名；前端域名需在 CORS 白名单                                           |
| pull 超时                  | daemon.json 加速是否生效；ACR 是否 login                                              |
| forge 失败                 | 查百炼 Key；`docker compose exec api node -e "console.log(require('ffmpeg-static'))"` |

更多（pg 备份、日志轮转、OOM、swap）见 [apps/api/DEPLOY.md](apps/api/DEPLOY.md)。

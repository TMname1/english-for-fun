# apps/api 生产部署指南（阿里云轻量服务器 + Cloudflare Tunnel）

架构：浏览器 → CF Pages 前端（你的域名）→ `https://api.你的域名` → Cloudflare Tunnel → 服务器上的 cloudflared 容器 → `127.0.0.1:3001` api 容器 → pg 容器（docker 内网）。媒体文件走 OSS 预签名 URL 直连，不经过 api。

**构建全程在本地**（Docker Desktop 提供 Linux 构建环境），服务器只 pull 成品镜像运行，不装 pnpm、不编译、不接触源码。

内存预算（2核2G）：api ≤1G（含 forge/ffmpeg 子进程）、pg ≤512M、cloudflared ~30M，其余留给系统；可选 2G swap 兜底（见文末）。

## 一、前置条件

- 阿里云轻量应用服务器：2核2G、**Docker 应用镜像**（预装 Docker；其他 Linux 镜像需自装 Docker）
- 域名 `你的域名` 已托管 Cloudflare；前端已上 CF Pages
- 阿里云 OSS 桶 + RAM 子账号 AccessKey：按根目录 [README.env.prod.md](../../README.env.prod.md) 完成建桶（私有）、授权、`tts/` 生命周期规则
- 百炼 DashScope API Key（forge 用）
- 阿里云容器镜像服务 ACR **个人实例**（免费）：控制台 → 容器镜像服务 → 个人实例 → 设置访问密码 → 创建命名空间 → 创建**私有**仓库 `earthworm-api`。**地域选与轻量服务器相同**（下文以 cn-hangzhou 为例）
- 本地 Windows 已装 Docker Desktop 并启动

## 二、本地构建与推送镜像

### 2.1 准备基础镜像（国内网络）

Docker Hub 在国内通常不可达。二选一：

- Docker Desktop → Settings → Docker Engine，加 registry mirror 后 Apply & Restart：
  ```json
  { "registry-mirrors": ["https://docker.m.daocloud.io"] }
  ```
- 或手动拉取并改名（本项目已验证可用）：
  ```bash
  docker pull docker.m.daocloud.io/library/node:20-bookworm-slim
  docker tag docker.m.daocloud.io/library/node:20-bookworm-slim node:20-bookworm-slim
  ```

### 2.2 构建（仓库根执行）

```bash
docker build --platform linux/amd64 -f apps/api/Dockerfile -t earthworm-api:local .
```

多阶段构建：builder 阶段在 Linux 里 `pnpm install`（ffmpeg-static 自动下载 linux-x64 二进制）→ `pnpm build:server` 编译 → `pnpm deploy` 导出自包含生产目录（含 dist、drizzle 迁移、生产 node_modules、三个 workspace 包产物），内置 8 项自检，任一缺失当场报错。runtime 阶段只拷贝该产物，最终镜像约 500MB。

> ffmpeg-static 从 GitHub 下载二进制，若超时：给 Docker Desktop 配代理，或在 Dockerfile builder 段临时加一行
> `ENV FFMPEG_BINARIES_URL=https://registry.npmmirror.com/-/binary/ffmpeg-static` 改用国内镜像源。

### 2.3 打 tag 并推送 ACR

```bash
# 建议双 tag：v1 + git 短 SHA，回滚有据
docker tag earthworm-api:local registry.cn-hangzhou.aliyuncs.com/<命名空间>/earthworm-api:v1
docker login --username=<阿里云账号全名> registry.cn-hangzhou.aliyuncs.com
# 密码 = ACR 控制台设置的固定访问密码（不是阿里云登录密码）
docker push registry.cn-hangzhou.aliyuncs.com/<命名空间>/earthworm-api:v1
```

## 三、服务器初始化

SSH 登录服务器后：

```bash
docker compose version   # Docker 应用镜像一般预装；缺则 apt-get install docker-compose-plugin
mkdir -p /opt/earthworm
```

把本目录（`apps/api/deploy/`）的三个文件上传到 `/opt/earthworm/`（scp 或粘贴均可）：
`docker-compose.yml`、`.env.example`、`.env.prod.example`。

### 3.1 配置国内镜像加速（拉 postgres / cloudflared 用）

Docker Hub 不可达，编辑 `/etc/docker/daemon.json`：

```json
{ "registry-mirrors": ["https://docker.m.daocloud.io"] }
```

`systemctl restart docker`。（也可用阿里云容器镜像服务控制台提供的专属加速器地址。）

### 3.2 填写环境变量

```bash
cd /opt/earthworm
cp .env.example .env
cp .env.prod.example .env.prod
chmod 600 .env .env.prod
```

- `.env`（compose 插值）：
  - `API_IMAGE`：完整镜像地址（与 2.3 推送的一致）
  - `POSTGRES_PASSWORD`：自定义强密码
  - `CLOUDFLARE_TUNNEL_TOKEN`：第五节创建 Tunnel 后获得
- `.env.prod`（api 运行时，逐项说明见文件内注释与 [README.env.prod.md](../../README.env.prod.md)）：
  - `DATABASE_URL` 中密码**必须与 `.env` 的 `POSTGRES_PASSWORD` 一致**，主机名保持 `pg`（docker 服务名）
  - `SECRET`：`openssl rand -hex 32` 生成
  - `AUTH_USERNAME` / `AUTH_PASSWORD`：生产登录凭证
  - `S3_*`：OSS 生产值（`S3_FORCE_PATH_STYLE="false"`、公网端点）
  - `FORGE_*`：百炼 Key 与模型配置

登录 ACR（私有仓库 pull 需要）：

```bash
docker login --username=<阿里云账号全名> registry.cn-hangzhou.aliyuncs.com
```

> 同地域可试 VPC 域名 `registry-vpc.cn-hangzhou.aliyuncs.com`（免公网流量），不通则用公网域名。

## 四、防火墙

阿里云轻量服务器防火墙**入方向只保留 SSH（22）**。不需要开 3001/5432：api 只绑 127.0.0.1，pg 无端口映射，对外流量全部走 Cloudflare Tunnel（出站连接，无需任何入站端口）。

## 五、创建 Cloudflare Tunnel

1. CF 面板 → **Zero Trust → Networks → Tunnels → Create a tunnel** → 选 **Cloudflared** → 命名 `earthworm-api`。
2. 页面给出安装命令（形如 `cloudflared service install eyJ...`）——**不要在服务器执行它**。我们改用容器跑 cloudflared：把命令里 `eyJ...` 开头的**整串 token** 复制，填到服务器 `/opt/earthworm/.env` 的 `CLOUDFLARE_TUNNEL_TOKEN`。
3. 下一步 **Public hostname**：
   - Subdomain: `api`，Domain: `你的域名`
   - Service: **HTTP**，URL: `localhost:3001`
   - 保存。CF 自动创建 DNS CNAME 并签发证书，无需手动加 A 记录。
4. compose 里 cloudflared 用 `network_mode: host`，所以 `localhost:3001` 能直达 api 映射到本机的端口。

> 备选：若日后把 cloudflared 改回 bridge 网络（去掉 `network_mode: host`、加入 compose 默认网络），面板 Service URL 必须改成 `http://api:3001`（容器服务名），`localhost` 在 bridge 下指向 cloudflared 自己。

## 六、首次启动（自动迁移）

```bash
cd /opt/earthworm
docker compose pull
docker compose up -d
docker compose logs -f api
```

api 启动命令先跑 `node dist/src/db/migrate.js`（drizzle 迁移，幂等，按 `__drizzle_migrations` 表去重），看到 `Woohoo! Migrations completed!` 后再启动 NestJS。迁移失败进程会退出并由 restart 策略重试，不会带病启动。

手动迁移兜底（排障用）：

```bash
docker compose run --rm api node dist/src/db/migrate.js
```

## 七、验证清单

- [ ] `docker compose ps`：pg healthy、api healthy（探针为未登录 401）、cloudflared Up
- [ ] `docker compose exec pg psql -U earthworm -d earthworm -c '\dt'` 有表
- [ ] 服务器本机 `curl -i http://127.0.0.1:3001/auth/me` → **401 JSON**（api 无 health 路由，401 即代表进程与认证链正常）
- [ ] `curl -i -X POST http://127.0.0.1:3001/auth/login -H "Content-Type: application/json" -d '{"username":"<用户名>","password":"<密码>"}'` → 200 + Set-Cookie
- [ ] `curl -i https://api.你的域名/auth/me` → 401（CF 链路通）；CF 面板 tunnel 状态 HEALTHY
- [ ] 浏览器从 `https://你的域名` 登录成功（CORS + secure Cookie 全链路）
- [ ] 上传音频/视频走 OSS 成功；TTS 发音正常；跑一个 forge 转写任务（验证 ffmpeg 子进程）
- [ ] `docker compose down && docker compose up -d` 后数据仍在（pg 卷正确）；重启服务器后三容器自动拉起
- [ ] 公网扫描确认 3001/5432 不可达

> 注意：prod Cookie 为 `secure + sameSite=none`，**浏览器必须走 https 域名登录**；直接访问 `http://服务器IP:3001` 登录不上属预期（且端口本就未对公网开放）。CORS 白名单硬编码含 `https://你的域名`，CF Pages 预览域名（`*.pages.dev`）不在白名单，属已知现状。

## 八、日常更新与回滚

```bash
# 本地：改代码后重新 build → push 新 tag（如 v2）
# 服务器：
cd /opt/earthworm
vi .env                      # API_IMAGE 改为新 tag
docker compose pull api
docker compose up -d api     # 迁移随启动自动跑
```

回滚：`.env` 的 `API_IMAGE` 改回旧 tag，再 `pull api && up -d api`。

## 九、运维

- 日志已轮转（每容器 10MB×3）：`docker compose logs -f api`
- 40GB 盘定期清理：`docker system df` 查看，`docker image prune -f` 清无 tag 镜像
- pg 备份（建议 cron 每日并下载到本地）：
  ```bash
  docker compose exec pg pg_dump -U earthworm earthworm > backup-$(date +%F).sql
  ```
- 重启策略 `unless-stopped` + Docker 开机自启（应用镜像默认 enable），服务器重启后自动恢复

## 十、故障排查

| 现象                       | 排查                                                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| api 反复重启               | `docker compose logs api`：迁移失败查 `DATABASE_URL`/pg 是否 healthy；缺 env 查 `.env.prod`                                        |
| CF 返回 502 / Error 1033   | cloudflared 日志查 token 是否有效；面板 Service URL 是否 `localhost:3001`（host 网络）；`docker compose ps` 看 cloudflared 是否 Up |
| 浏览器登录不上但 curl 正常 | 必须走 `https://api.你的域名`（secure Cookie）；前端域名是否在 CORS 白名单                                                         |
| forge 转写失败             | `docker compose exec api node -e "console.log(require('ffmpeg-static'))"` 确认二进制存在；百炼 Key/模型配置                        |
| 容器被 OOMKill             | `docker stats`；api 限额 1G、`--max-old-space-size=768` 已给子进程留量；必要时加 swap                                              |
| pull 超时                  | daemon.json 镜像加速是否生效；ACR 是否已 login；同地域试 VPC 域名                                                                  |

## 十一、可选：2G swap（小内存保险丝）

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
sysctl vm.swappiness=10 && echo 'vm.swappiness=10' >> /etc/sysctl.conf
```

正常负载不应吃 swap；forge（ffmpeg + ASR）高峰期 swap 防 OOM。

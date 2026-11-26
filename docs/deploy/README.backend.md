# 后端部署操作指南（README.backend.md）

把 `apps/api` 部署到阿里云 ECS（2核2G），通过 Cloudflare Tunnel 对外提供 `https://api.你的域名`。
环境变量逐项说明见 [README.env.prod.md](README.env.prod.md)。

## 架构与原理

```
浏览器 → https://你的域名（CF Pages 前端）
       → https://api.你的域名（CF 自动签证书）
       → Cloudflare Tunnel（出站连接，服务器无需开任何入站端口）
       → 宿主机 cloudflared（apt 安装，systemd 服务）
       → 127.0.0.1:3001 api 容器（NestJS）
       → pg 容器（Postgres 16，仅 docker 内网，数据挂卷）
媒体文件走 OSS 预签名 URL 直连，不经过 api。
```

要点：

- **构建全程在本地**：Docker Desktop 在本机提供 Linux 构建环境，产出完整镜像（含 dist、生产依赖、drizzle 迁移、linux 版 ffmpeg）。服务器只 `docker pull` 运行成品，不装 pnpm、不编译、不接触源码。
- **不能只上传 dist**：NestJS 是 tsc 编译，dist 非自包含，必须连同 Linux 版 node_modules 一起打包，这正是 Dockerfile 做的事。
- **Tunnel 只要求出站，不要求入站**：cloudflared 主动连 Cloudflare 边缘，安全组入方向一个业务端口都不用开。但服务器**必须有公网出口**（EIP 或 NAT 网关）——无出口时 cloudflared 连不上 Cloudflare，隧道无法建立。
- **未备案域名必须走 Tunnel**：大陆服务器对未备案域名的 80/443 入站会被阿里云阻断（.cc 等域名无法备案），直连方案不可行。
- **素材上传必须是浏览器直传 OSS**：Cloudflare 对回源有 **100s 硬超时**（所有套餐一致，不可调），而本项目的 Tunnel 回源有效上行实测只有 ~47KB/s（cloudflared 落到了洛杉矶边缘 + 丢包）。走 API 中转时 8MB 素材都传不完，必然 524。现在前端先 `POST /forge/uploads/presign`（课程包配套视频走 `POST /course-pack/video/presign`）拿预签名 PUT，浏览器直接写 OSS，再用 `.../from-upload` 只带 `videoKey` 完成建任务/入库。**代价是 OSS 桶必须配 CORS**（见 [README.env.prod.md](../env/README.env.prod.md)）。
- **旧 multipart 入口（`POST /forge/jobs`）只做兼容**：给缓存了旧前端产物的页面兜底；它会重新把素材经 Tunnel 拉到服务器，大文件必然 524，不要再用。
- 内存预算：api ≤1G（含 forge/ffmpeg 子进程）、pg ≤512M、cloudflared ~30M，其余留给系统；可选 2G swap 兜底（见文末）。

## 前置条件

- 阿里云 ECS（2核2G 起步），**有公网出口**：绑按量 EIP（按流量计费，小流量场景约 ¥15-20/月）或 VPC 配 NAT 网关 + SNAT。EIP 需长期绑定——Tunnel 是常驻长连接，解绑即断网
- 域名 `你的域名` 托管 Cloudflare，前端已上 CF Pages
- OSS 桶 + RAM AccessKey、百炼 Key：按 [README.env.prod.md](README.env.prod.md) 完成
- 阿里云容器镜像服务 ACR **个人实例**（免费，见第 1 步）
- 本地 Windows 装好 Docker Desktop 并启动

## 第 1 步：开通阿里云 ACR（镜像仓库，免费）

控制台 → 容器镜像服务 → **个人实例**：

1. 设置访问密码（push/pull 登录用，不是阿里云登录密码）
2. 创建命名空间（如 `my-ns`）
3. 创建**私有**仓库 `earthworm-api`
4. **地域选与 ECS 相同**（下文以 cn-hangzhou 为例）

## 第 2 步：本地构建镜像（仓库根执行）

国内 Docker Hub 通常不可达，先准备基础镜像（二选一）：

```bash
# 方式 A：手动拉取并改名
docker pull --platform linux/amd64 docker.m.daocloud.io/library/node:22-bookworm-slim
docker tag docker.m.daocloud.io/library/node:22-bookworm-slim node:22-bookworm-slim

# 方式 B：Docker Desktop → Settings → Docker Engine 加 mirror 后 Apply & Restart
#   { "registry-mirrors": ["https://docker.m.daocloud.io"] }
#   注意：阿里云个人版镜像加速器（*.mirror.aliyuncs.com）已停用，请求会返回 403 Forbidden，不要再配。
```

构建（首次约几分钟，产出约 500MB）：

```bash
docker build --platform linux/amd64 -f apps/api/Dockerfile -t earthworm-api:local .
```

Dockerfile 内置 10 项产物自检（入口/迁移/forge/ffmpeg/drizzle meta/三个 workspace 包/两个 LangGraph 包），缺任何一项构建当场失败。
ffmpeg-static 从 GitHub 下载二进制若超时：给 Docker Desktop 配代理，或在 Dockerfile builder 段临时加
`ENV FFMPEG_BINARIES_URL=https://registry.npmmirror.com/-/binary/ffmpeg-static`。

## 第 3 步：推送镜像到 ACR

请在`容器镜像服务->实例列表->镜像仓库->基本信息`中查看具体命令，下面的地址是不准确的，只是给个参考

```bash
docker tag earthworm-api:local registry.cn-hangzhou.aliyuncs.com/<命名空间>/earthworm-api:v1
echo '<密码>' | docker login --username=<阿里云账号全名> --password-stdin registry.cn-hangzhou.aliyuncs.com
docker push registry.cn-hangzhou.aliyuncs.com/<命名空间>/earthworm-api:v1
```

建议双 tag（v1 + git 短 SHA），回滚有据。

## 第 4 步：服务器初始化

SSH 登录服务器：

```bash
# ECS 普通 Linux 镜像需自装 Docker（Ubuntu 源里 compose 插件是单独的包）
sudo apt-get install -y docker.io docker-compose-v2
sudo systemctl enable --now docker
docker compose version        # 验证
mkdir -p /opt/earthworm
```

1. **配镜像加速**（拉 postgres 用，Docker Hub 被墙）：编辑 `/etc/docker/daemon.json`（已有内容则合并，勿覆盖）：
   ```json
   { "registry-mirrors": ["https://docker.m.daocloud.io"] }
   ```
   然后 `systemctl restart docker`。也可用 ACR 控制台提供的专属加速器地址。
2. 把 `apps/api/deploy/` 的三个文件上传到 `/opt/earthworm/`：
   `docker-compose.yml`、`.env.example`、`.env.prod.example`
3. 填写环境变量：

   ```bash
   cd /opt/earthworm
   cp .env.example .env
   cp .env.prod.example .env.prod
   chmod 600 .env .env.prod
   ```

   **两个 env 文件的区别（给两个不同的"读者"用，勿合并）**：

   | 文件        | 读者                                                               | 内容                                                                                    |
   | ----------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
   | `.env`      | **docker compose 本身**（宿主机），做 compose 文件里 `${...}` 插值 | `API_IMAGE`（第 3 步的完整镜像地址，回滚改这一行）、`POSTGRES_PASSWORD`（注入 pg 容器） |
   | `.env.prod` | **api 容器**，经 `env_file` 整体注入，是 NestJS 应用的运行时配置   | `DATABASE_URL`、`SECRET`、`AUTH_*`、`S3_*`、`FORGE_*`                                   |

   分开的原因：最小权限——api 进程不该拿到数据库根密码等部署级变量；且 compose 插值只认 `.env`，`env_file` 内容不会反过来用于插值。

   **`DATABASE_URL` 必须按此格式填写（三处一个都不能错，否则 api 连不上库并反复重启）**：

   ```
   DATABASE_URL="postgres://earthworm:<与.env中POSTGRES_PASSWORD一致>@pg:5432/earthworm"
   ```

   - **主机名 = `pg`，绝不能写 `localhost`/`127.0.0.1`**：api 跑在容器里，`localhost` 指的是容器自身而非 pg 容器，会一直 `ECONNREFUSED 127.0.0.1:5432`。`pg` 才是 compose 里的服务名，且 pg 不对外开端口、仅 docker 内网可达。
   - **用户名 = `earthworm`**：compose 用 `POSTGRES_USER: earthworm` 建库（第 11 行），写成别的（如系统用户名）会接着报 `password authentication failed for user "..."`。
   - **密码 = `.env` 里的 `POSTGRES_PASSWORD`**，两处必须完全一致。
   - ⚠️ 密码若含 `@ / : ? # [ ]` 等字符，在 URL 中须做百分号转义（如 `@`→`%40`），否则连接串会被解析器截断；最省事是让 `POSTGRES_PASSWORD` 只用字母数字。

   其余要点：`SECRET` 用 `openssl rand -hex 32` 生成；`NODE_ENV=prod` / `PORT=3001` 镜像已内置，无需填写。逐项说明见 [README.env.prod.md](README.env.prod.md)。

4. 登录 ACR（私有仓库 pull 需要）：
   ```bash
   docker login --username=<阿里云账号全名> registry.cn-hangzhou.aliyuncs.com
   ```
   同地域可试 VPC 端点 `registry-vpc.cn-hangzhou.aliyuncs.com`（免公网流量），不通则用公网域名。
5. **安全组**：入方向**只留 SSH（22）**（源最好限自己的 IP），不开 80/443/3001/5432。api 只绑 127.0.0.1，pg 无端口映射，对外流量全部走 Tunnel。

## 第 5 步：创建 Cloudflare Tunnel（宿主机 cloudflared）

1. 服务器安装 cloudflared（官方 apt 源）：
   ```bash
   sudo mkdir -p --mode=0755 /usr/share/keyrings
   curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
   echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
   sudo apt-get update && sudo apt-get install -y cloudflared
   ```
2. CF 面板 → **Zero Trust → Networks → Tunnels → Create a tunnel** → 选 **Cloudflared** → 命名 `earthworm-api`
3. 页面给出安装命令（`cloudflared service install eyJ...`）——**在服务器直接执行它**。会注册成 systemd 服务，开机自启、断线自动重连
4. **Public hostname**：Subdomain `api`，Domain `你的域名`；Service **HTTP**，URL `http://localhost:3001`；保存。CF 自动建 DNS CNAME 并签证书，无需手动 A 记录
5. 验证：`sudo systemctl status cloudflared` 为 active；CF 面板 tunnel 状态 HEALTHY

> 大陆出站连 CF 边缘偶发慢/不稳：QUIC(UDP 7844) 不通时 cloudflared 自动降级 HTTP2(443)，一般无碍。

## 第 6 步：启动与验证

```bash
cd /opt/earthworm
docker compose pull
docker compose up -d
docker compose logs -f api    # 看到 "Woohoo! Migrations completed!" 后 Nest 启动
```

迁移每次启动自动跑（幂等，按 `__drizzle_migrations` 表去重）；失败进程退出由 restart 策略重试，不会带病启动。
手动迁移兜底（排障用）：`docker compose run --rm api node dist/src/db/migrate.js`

验证清单：

```bash
docker compose ps                                        # pg/api healthy
sudo systemctl status cloudflared                        # active；CF 面板 tunnel HEALTHY
docker compose exec pg psql -U earthworm -d earthworm -c '\dt'   # 有表
curl -i http://127.0.0.1:3001/auth/me                    # 401 JSON = 正常（无 health 路由）
curl -i -X POST http://127.0.0.1:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"<用户名>","password":"<密码>"}'        # 200/201 + Set-Cookie
curl -i https://api.你的域名/auth/me                      # 401 = CF 链路通
```

最后浏览器打开 `https://你的域名`：登录、上传音频/视频（走 OSS）、TTS 发音、跑一个 forge 转写（验证 ffmpeg 子进程）各试一次。
再 `docker compose down && docker compose up -d` 确认数据仍在（pg 卷正确）；重启服务器后容器与 cloudflared 自动拉起；公网扫描确认 3001/5432 不可达。

> 浏览器必须走 https 域名登录（prod Cookie 是 `Secure; SameSite=None`）；直接访问 `http://服务器IP:3001` 登录不上属预期（端口本就未对公网开放）。`*.pages.dev` 预览域名不在 CORS 白名单，属已知现状。

## 日常更新与回滚

```bash
# 本地：改代码 → 重新 build → push 新 tag（如 v2）
# 服务器：
cd /opt/earthworm
vi .env                          # API_IMAGE 改新 tag
docker compose pull api && docker compose up -d api   # 迁移随启动自动跑
```

回滚：`API_IMAGE` 改回旧 tag 再 `pull api && up -d api`。

## 运维

- 日志已轮转（每容器 10MB×3）：`docker compose logs -f api`；cloudflared 日志走 journald：`journalctl -u cloudflared -f`
- 盘定期清理：`docker system df` 查看，`docker image prune -f` 清无 tag 镜像
- pg 备份（建议 cron 每日并下载到本地）：
  ```bash
  docker compose exec pg pg_dump -U earthworm earthworm > backup-$(date +%F).sql
  ```
- 重启策略 `unless-stopped` + Docker 开机自启 + cloudflared systemd 自启，服务器重启后自动恢复

## 常见问题速查

| 现象                                    | 处理                                                                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| api 反复重启                            | `docker compose logs api`：迁移失败查 `DATABASE_URL`/pg 是否 healthy；缺 env 查 `.env.prod`                                                                                                       |
| 日志刷 `ECONNREFUSED 127.0.0.1:5432`    | `DATABASE_URL` 主机填成了 `localhost`，应改成服务名 `pg`；改后 `docker compose up -d --force-recreate api`（`restart` 不重读 env_file）                                                           |
| 接着报 `password authentication failed` | 主机名已对但账号/密码不对：用户须是 `earthworm`、密码须与 `.env` 的 `POSTGRES_PASSWORD` 一致；含特殊字符要百分号转义                                                                              |
| CF 502 / Error 1033                     | `systemctl status cloudflared` 与 `journalctl -u cloudflared`：token 是否有效、面板 Service URL 是否 `localhost:3001`                                                                             |
| 浏览器登录不上但 curl 正常              | 必须走 https 域名（Secure Cookie）；前端域名需在 CORS 白名单                                                                                                                                      |
| pull 超时                               | daemon.json 加速是否生效；ACR 是否 login；同地域试 VPC 端点                                                                                                                                       |
| forge 失败                              | 查百炼 Key；`docker compose exec api node -e "console.log(require('ffmpeg-static'))"` 确认二进制存在                                                                                              |
| 上传素材 524 / 按钮一直转圈             | 旧路径会把文件经 Tunnel 拉到服务器，100s 必超时。确认 Network 里有 `/forge/uploads/presign` 或 `/course-pack/video/presign`（直传）；再查 OSS 桶 CORS（控制台报 `blocked by CORS policy` 就是它） |
| 直传后 403 SignatureDoesNotMatch        | 预签名过期（默认 10 分钟）或浏览器改写了签名头；刷新重试；检查服务器时间是否偏差过大（NTP）                                                                                                       |
| 容器被 OOMKill                          | `docker stats`；api 限额 1G、`--max-old-space-size=768` 已给子进程留量；必要时加 swap                                                                                                             |
| 服务器完全无出站                        | 查 EIP 是否绑定/欠费释放、VPC 是否有 NAT 网关 + SNAT；`curl -sI https://mirrors.aliyun.com` 验证                                                                                                  |

## 可选：2G swap（小内存保险丝）

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
sysctl vm.swappiness=10 && echo 'vm.swappiness=10' >> /etc/sysctl.conf
```

正常负载不应吃 swap；forge（ffmpeg + ASR）高峰期 swap 防 OOM。

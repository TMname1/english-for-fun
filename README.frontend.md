# 前端部署指南（Cloudflare Pages）

前端是 Nuxt 3 纯静态 SPA（`ssr: false`），构建产物为 `apps/client/.output/public`，通过 Wrangler CLI 直传部署到 Cloudflare Pages。

- 线上地址：`https://你的域名`（CF Pages 项目名 `english-for-fun`，临时地址形如 `<项目名>-<账号hash>.pages.dev`）
- 后端 API：`https://api.你的域名`（Cloudflare Tunnel → 阿里云服务器 `localhost:3001`，后端部署见 `README.env.prod.md`，不在本文范围）

## 前置条件

| 依赖            | 要求                                        | 说明                                      |
| --------------- | ------------------------------------------- | ----------------------------------------- |
| Node.js         | **20.x**（仓库 `.node-version` 为 20.12.2） | Node 22+ 会导致构建失败，见下方"常见问题" |
| pnpm            | 9.x                                         | `packageManager` 已锁定                   |
| Wrangler        | 已装（根 devDependency）                    | 首次需 `pnpm wrangler login` 浏览器授权   |
| Cloudflare 账号 | 拥有 `你的域名` 域名                        | 域名 DNS 托管在 CF                        |

### 系统 Node 版本不符时（临时方案）

不改系统环境，下载便携版 Node 20 并临时加入 PATH（Git Bash）：

```bash
mkdir -p /tmp/node20 && cd /tmp/node20
curl -sL -o node.zip https://npmmirror.com/mirrors/node/v20.12.2/node-v20.12.2-win-x64.zip
unzip -q node.zip
export PATH="/tmp/node20/node-v20.12.2-win-x64:$PATH"
node -v   # 应输出 v20.12.2
```

Linux/macOS 换对应平台的包即可；或直接用 nvm/fnm 安装 20.12.2。

## 部署步骤

### 1. 安装依赖

```bash
pnpm install
```

仓库带一个必要补丁 `patches/nitropack@2.9.6.patch`（修复 nitro 预渲染器在 Windows 上的崩溃，nuxt/nuxt#26943），`pnpm install` 会自动应用，无需手动处理。

### 2. 配置生产环境变量

创建 `apps/client/.env.prod`（已 gitignore，不入库）：

```bash
API_BASE="https://api.你的域名"
```

`generate` 脚本通过 `--dotenv .env.prod` 读取它，构建时注入 `runtimeConfig.public.apiBase`。
可选：`ALLOW_FORGE="0"` 关闭"导入视频"入口（默认开启）。

### 3. 登录 Wrangler（仅首次）

```bash
pnpm wrangler login
```

浏览器打开 Cloudflare 授权页，点击允许。用 `pnpm wrangler whoami` 确认登录态。

### 4. 构建并部署

```bash
pnpm deploy:client
```

该脚本 = `pnpm build:client`（nuxt generate，产物在 `apps/client/.output/public`）+ `wrangler pages deploy`。

首次部署前项目已创建（`english-for-fun`，production 分支 `main`）。如需在新账号重建：

```bash
pnpm wrangler pages project create english-for-fun --production-branch main
```

部署成功后输出形如 `https://<hash>.<项目名>-<账号hash>.pages.dev` 的预览地址，生产地址为 `https://<项目名>-<账号hash>.pages.dev`。

### 5. 绑定自定义域名（仅首次）

CF 面板 → Workers & Pages → `english-for-fun` → Custom domains → Set up a custom domain → 填 `你的域名` → 激活。域名已在 CF 托管，DNS 记录自动创建。

## 后端配合（前端登录依赖）

前端与 API 跨站，登录 Cookie 需要后端满足两个条件（代码已改好，需部署到服务器）：

1. `apps/api/src/main.ts` CORS 白名单包含 `https://你的域名`；
2. `apps/api/src/auth/auth.service.ts` 在 `NODE_ENV=prod` 时 Cookie 为 `SameSite=None; Secure`。

后端 HTTPS 由 Cloudflare Tunnel 提供（首次配置）：

1. CF 面板 → Zero Trust → Networks → Tunnels → Create a tunnel（Cloudflared），命名 `earthworm-api`；
2. 复制面板给出的安装命令（含 token），在阿里云服务器执行；
3. 为该 Tunnel 添加 Public hostname：`api.你的域名` → Service `http://localhost:3001`；
4. CF 自动创建 DNS 记录并签发 HTTPS 证书。阿里云安全组无需开放 3001。

## 验证清单

1. 服务器执行 `curl https://api.你的域名/auth/me` → 返回 401 JSON（Tunnel 链路通）；
2. 打开 `https://你的域名` → 页面正常加载；
3. 登录成功，DevTools 中 `auth_token` Cookie 带 `SameSite=None; Secure`，后续请求携带 Cookie；
4. 深链刷新（如 `/course-pack/xxx`）页面正常渲染（由 Pages 原生 `404.html` 兜底；HTTP 状态码是 404 属预期，纯 SPA 无 SSR 不影响使用）；
5. 课程学习、每日一句、B 站扫码登录状态接口正常；媒体走 OSS 预签名 URL 直连，与本次部署无关。

## 常见问题

**构建报 `The argument 'filename' must be a file URL ... Received 'file:///_entry.js'`**
nitropack 2.9.6 预渲染器在 Windows 上的已知问题（nuxt/nuxt#26943）。确认 `patches/nitropack@2.9.6.patch` 存在且 `pnpm install` 已应用（node_modules 中 nitropack 目录名带 `patch_hash`）。

**构建报其他奇怪错误 / 预渲染失败**
先确认 Node 版本是 20.x（`node -v`）。Node 22+ 与 Nuxt 3.12 工具链不兼容。

**本机打不开 pages.dev / 部署后 curl 超时**
大陆网络访问 `pages.dev` 常被阻断，不代表部署失败。用 `pnpm wrangler pages deployment list --project-name english-for-fun` 确认部署状态，浏览器验证走自定义域名 `你的域名`。CF 免费套餐在大陆速度一般，面向大陆用户请实测。

**登录后一直跳回 /login**
按顺序检查：后端是否 HTTPS（Tunnel 是否生效）→ 后端代码是否包含 CORS/Cookie 改动并重启 → DevTools 里 Cookie 是否被浏览器拒收（缺 `Secure` 或 `SameSite=None`）。

**站点报 `ERR_TOO_MANY_REDIRECTS`（重定向次数过多）**

不要新增 `/* → *.html` 的 rewrite 规则（如 `_redirects` 里的 `/* /200.html 200`）。Pages 有一条关不掉的"去 `.html` 扩展名"规范化：`/200.html` 会被 308 到 `/200`，而 `/200` 又命中同一条通配规则 → 无限循环；且规则优先于静态资源匹配，连 `/_nuxt/*.js`、`/favicon.ico` 都会被一起劫持，整站不可用。SPA 深链交给 Pages 原生的 `404.html` 兜底即可。

修复后浏览器仍报错是 308 被缓存所致：用无痕窗口，或 DevTools → Network 勾 Disable cache 硬刷新，必要时清除本站站点数据。

## 相关文件

- `apps/client/.env.prod` — 生产 API 地址（不入库）
- `patches/nitropack@2.9.6.patch` — Windows 构建补丁
- 根 `package.json` — `build:client` / `deploy:client` 脚本
- `README.env.prod.md` — 后端生产环境变量与部署

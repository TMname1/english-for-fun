# 单用户登录说明（README.login.md）

本项目只允许**一个用户**登录使用：没有注册功能，用户名和密码写在后端环境变量里。未登录时，前端所有页面都会跳转到登录页，后端所有接口（包括 TTS、Swagger）一律返回 401。课程音视频存对象存储，前端拿**预签名 URL 直连**播放——URL 有效期内持链接即可访问，不再经过登录校验。

## 快速开始

1. 在 `apps/api/.env` 中配置登录凭证（模板见 `apps/api/.env.example`）：

   ```dotenv
   AUTH_USERNAME="admin"
   AUTH_PASSWORD="换成你的密码"
   # 登录 Cookie 的签名密钥，任意长随机字符串即可
   SECRET="换成一个长随机字符串"
   ```

   三个变量都**必填**，缺少任何一个后端会启动失败。模板里的用户名、密码与 SECRET 均为示例占位值，复制后**务必换成自己的强密码和随机串**。

2. 正常启动前后端：

   ```bash
   pnpm dev:serve    # API，默认 http://localhost:3001
   pnpm dev:client   # 前端，默认 http://localhost:3000
   ```

3. 打开前端任意页面会自动跳到 `/login`，输入上面的用户名密码登录。登录成功后导航栏右侧会显示头像、用户名和退出登录按钮。

## 工作原理

- 登录接口 `POST /auth/login` 校验 env 中的用户名密码，成功后发放一个 **httpOnly Cookie**（`auth_token`），有效期 **7 天**，页面脚本读不到它。
- Cookie 内容是用 `SECRET` 做 HMAC-SHA256 签名的令牌，后端每次请求都验签 + 验过期，**不依赖数据库**，也没有 users 表。
- 认证在 Express 中间件层全局生效（`apps/api/src/app/useGlobal.ts`），因此 Nest 路由、Swagger 全部被保护；唯一放行的是 `POST /auth/login` 和 CORS 预检请求。对象存储预签名 URL 直连不经过 API，不受此保护。
- 前端全局路由中间件（`apps/client/middleware/auth.global.ts`）在每次进入页面时检查登录态；任何 API 返回 401 也会自动跳回 `/login`。
- 相关接口：`POST /auth/login`（登录）、`POST /auth/logout`（退出）、`GET /auth/me`（当前用户）。

## 修改头像

头像是固定路径的图片文件：`apps/client/public/avatar.png`，浏览器访问路径为 `/avatar.png`。

**想换头像，直接用新图片覆盖这个文件即可**（保持文件名 `avatar.png` 不变，建议正方形 png/jpg）：

- 开发环境：覆盖后刷新页面立即生效。
- 生产环境：前端构建产物在 `.output/public/` 下，覆盖其中的 `avatar.png`（或覆盖源文件后重新 `pnpm build:client`）。

## 修改用户名 / 密码

编辑 `apps/api/.env` 的 `AUTH_USERNAME` / `AUTH_PASSWORD`，重启后端生效。

注意两点：

- **改密码不会立刻踢掉已登录的会话**：已发放的 Cookie 在 7 天有效期内仍然有效。想立刻让所有旧登录失效，把 `SECRET` 换成一个新随机值再重启（旧 Cookie 全部验签失败）。
- 测试环境（`apps/api/.env.test`）有一套独立的 `AUTH_USERNAME=test / AUTH_PASSWORD=test-password`，e2e 测试用它自动登录，改生产凭证不影响测试。

## 课程导入脚本（forge:import）

`pnpm forge:import` 通过 HTTP 调 API 导入课程，现在也需要登录：

- **由后端「导入视频」页面发起的流水线**：子进程自动继承后端的 `AUTH_USERNAME/AUTH_PASSWORD`，无需额外配置。
- **手动跑 CLI**：在 `apps/api/.env`（或进程环境变量）里配置 `AUTH_USERNAME/AUTH_PASSWORD`，导入前会自动登录换取 Cookie。

`pnpm db:upload`（xingrong-courses）直接写数据库，不走 HTTP，不受登录影响。

## 部署注意事项

- Cookie 使用 `SameSite=Lax`：前端和 API 需**同站**（如本地 `localhost:3000` → `localhost:3001`，端口不同没关系；生产建议同域名反向代理）。若前后端部署在完全不同的域名下，Cookie 不会被发送，需要改为同域部署。
- API 的 CORS 已开启 `credentials: true`，允许的 origin 见 `apps/api/src/main.ts`（localhost 与 earthworm.cuixueshe.com），新增域名时在那里补。
- 登录凭证只存在于后端 env，**不要**把 `AUTH_PASSWORD` 放进 `apps/client/.env`（前端 env 会打包进浏览器产物）。
- Swagger（`/swagger`）同样需要登录：先在浏览器里登录前端，再打开 Swagger 即可携带 Cookie 访问。

## 涉及的主要文件

| 位置                                    | 作用                                                          |
| --------------------------------------- | ------------------------------------------------------------- |
| `apps/api/src/auth/`                    | 登录/退出/me 接口、令牌签发与校验、全局认证中间件             |
| `apps/api/src/app/useGlobal.ts`         | 注册全局认证中间件                                            |
| `apps/api/src/main.ts`                  | CORS `credentials: true`                                      |
| `apps/client/pages/login.vue`           | 登录页（独立布局，无导航栏）                                  |
| `apps/client/middleware/auth.global.ts` | 前端全局路由守卫                                              |
| `apps/client/api/http.ts`               | 请求携带 Cookie（`credentials: "include"`）、401 自动跳登录页 |
| `apps/client/components/Navbar.vue`     | 头像 + 用户名 + 退出登录按钮                                  |
| `apps/client/public/avatar.png`         | 固定头像文件                                                  |
| `apps/api/test/helper/utils.ts`         | e2e 自动登录助手 `createAuthedAgent`                          |

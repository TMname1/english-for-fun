# 构建（仓库根执行）：
#   docker build --platform linux/amd64 -f apps/api/Dockerfile -t earthworm-api:local .
# 部署说明见 apps/api/DEPLOY.md

########## builder：在 Linux 环境安装依赖并编译 ##########
FROM node:20-bookworm-slim AS builder
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CYPRESS_INSTALL_BINARY=0 \
    SKIP_INSTALL_SIMPLE_GIT_HOOKS=1
RUN corepack enable
WORKDIR /repo

# 先拷清单层（缓存友好）；workspace 全部 importer 的 package.json 都要在，否则 pnpm 解析报 ENOENT
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY patches/ ./patches/
COPY apps/api/package.json apps/api/
COPY apps/client/package.json apps/client/
COPY packages/schema/package.json packages/schema/
COPY packages/storage/package.json packages/storage/
COPY packages/game-data-sdk/package.json packages/game-data-sdk/
COPY packages/xingrong-courses/package.json packages/xingrong-courses/

# pnpm 9 的 deploy 命令要求 inject-workspace-packages=true（仓库本身无 .npmrc，仅构建期临时写入）
RUN printf 'inject-workspace-packages=true\n' > .npmrc

# 过滤安装 api 及其 workspace 依赖，避开 client 的 nuxt/cypress；
# 不能加 --ignore-scripts：ffmpeg-static 需要 postinstall 下载 linux-x64 二进制
RUN pnpm install --frozen-lockfile --filter api...

COPY apps/api/ apps/api/
COPY packages/schema/ packages/schema/
COPY packages/storage/ packages/storage/
COPY packages/game-data-sdk/ packages/game-data-sdk/
RUN pnpm build:server

# 导出自包含生产目录；必须在 build 之后 deploy，注入的 workspace 副本才含 dist
RUN pnpm deploy --filter=api --prod /prod/api \
 && test -x /prod/api/node_modules/ffmpeg-static/ffmpeg \
 && test -f /prod/api/dist/src/main.js \
 && test -f /prod/api/dist/src/db/migrate.js \
 && test -f /prod/api/dist/src/forge/core/pipeline-runner.js \
 && test -d /prod/api/drizzle/meta \
 && test -f /prod/api/node_modules/@earthworm/schema/dist/index.js \
 && test -f /prod/api/node_modules/@earthworm/storage/dist/index.js \
 && test -f /prod/api/node_modules/@earthworm/game-data-sdk/dist/index.js

########## runtime：只带运行所需产物 ##########
FROM node:20-bookworm-slim
ENV NODE_ENV=prod PORT=3001
WORKDIR /app
COPY --from=builder --chown=node:node /prod/api ./
USER node
EXPOSE 3001
# 无 health 路由：未登录打 /auth/me 得 401 即代表进程与认证链正常
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/auth/me').then(r=>process.exit(r.status===401?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/main"]
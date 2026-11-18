## ⚡ 介绍

通过连词构句的方式让你更好的学习英语~ 😊

## 📦 项目结构

pnpm monorepo：两个应用（`apps/`）+ 六个共享包（`packages/`）。各包详细文档见对应 README。

### 应用（apps/）

| 目录          | 说明                                                                                                                                                            | 文档                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `apps/api`    | 后端服务（NestJS + Drizzle/Postgres，默认 3001 端口）：课程包 CRUD、学习进度/时长统计、已掌握词、Edge TTS、每日一句、B 站扫码下载、forge 课程制作流水线 job API | [README](./apps/api/README.md)    |
| `apps/client` | 前端（Nuxt 3 SPA + Nuxt UI + Pinia）：打字输入式学习游戏（中译英/听写）、课程包管理、视频原声 seek 播放、「导入视频」流水线 GUI（切片→转写→校对→导入）          | [README](./apps/client/README.md) |

### 共享包（packages/）

| 目录                        | 说明                                                                                                                        | 文档                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `packages/schema`           | 全部 Drizzle 表定义的单一事实来源（课程包/句子/进度/学习时长/已掌握词/历史），tsup 构建                                     | [README](./packages/schema/README.md)           |
| `packages/db`               | Postgres 连接实例与建表/迁移脚本（`pnpm db:init` 等命令的底层）                                                             | [README](./packages/db/README.md)               |
| `packages/game-data-sdk`    | 课程包数据访问层：`createCoursePack` / `updateCoursePack` / `deleteCoursePack`（事务写库，含视频时间戳），供 API 与脚本复用 | [README](./packages/game-data-sdk/README.md)    |
| `packages/course-forge`     | 视频/音频 → 课程包流水线：百炼 ASR 转写 → LLM 拆句预处理 → LLM 结构化 → 时间戳对齐 → 校对导入；支持 CLI 与 Web GUI 两种用法 | [README](./packages/course-forge/README.md)     |
| `packages/bilidown`         | B 站视频下载器（BiliDown 的 Node CLI 逆向复刻）：扫码登录 + DASH 取流 + ffmpeg 混流；也被 API 的 bili 模块复用              | [README](./packages/bilidown/README.md)         |
| `packages/xingrong-courses` | 内置示例课程「星荣零基础学英语」的数据与导入脚本（`pnpm db:upload`，仅首次初始化用）                                        | [README](./packages/xingrong-courses/README.md) |

依赖关系大致为：`client → api → game-data-sdk / db → schema`；`course-forge` 独立跑流水线、通过 HTTP 导入 api；`bilidown` 被 api 桥接调用。

## 🚀 如何开始？

**以下所有相关操作都基于项目根目录位置，请注意检查不要出错！**

### 注意事项

- **pnpm version >= 8**

  ```bash
  corepack enable
  ```

- **Node.js version >= v20**
  > 使用来自 .node-version 的版本 [支持的工具](https://github.com/shadowspawn/node-version-usage#compatibility-testing)
- **Postgres version >= 8.0.0**
- 项目依赖 **Docker**，所以请确保你本地已安装并成功运行

### 编辑器

#### VSCode

- 安装推荐的插件 [extensions.json](./.vscode/extensions.json)

```bash
docker --version # Docker version 24.0.7, build afdd53b

node --version # v20+

pnpm -v # 8+
```

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置 `.env` 文件

可以选择将 `./apps/api/.env.example` 文件内容复制到 `./apps/api/.env`，请注意 `example` 文件中的是示例配置，主要是一些系统的环境变量信息，比如：数据库连接地址、用户名、密码、端口、密钥等等，后端服务会从此文件中读取配置信息，**当然你也可以更改成你自己的配置信息**。

Windows 用户推荐快捷键复制粘贴，Linux 用户可以通过下面的命令进行操作。

#### Server

```bash
cp ./apps/api/.env.example ./apps/api/.env
```

#### Client

```bash
cp ./apps/client/.env.example ./apps/client/.env
```

### 3. 启动 Docker Compose 服务

后端用到了 Postgres 和 MinIO（对象存储，dev 环境；prod 用阿里云 OSS，见 `README.devToProd.md`）服务，通过下面在 `package.json` 中配置的命令启动和停止。MinIO 首次启动会自动创建私有桶 `earthworm` 并给 `tts/` 缓存配置 30 天过期的生命周期规则，控制台在 `http://localhost:9001`（默认账号密码 minioadmin/minioadmin）。

```bash
# 启动
pnpm docker:start

# 下面这些命令等你用的时候在执行，不要傻乎乎的刚启动就停止哈 😊
# 停止
pnpm docker:stop
# 删除容器和网络（不会删除数据卷，数据保留在 db-data / testdb-data / minio-data 卷里）
pnpm docker:down
```

当然如果你更喜欢手动挡

```bash
docker compose up -d
docker compose stop
docker compose down

# 兼容老版本 docker 的命令
docker-compose up -d
```

### 4. 初始化数据库表结构

执行这个命令时，尽量与上个命令间隔一点时间，因为刚刚使用的 `-d` 参数会让其服务挂起在后台执行，此时 docker 服务可能还在 running 中，若是发现报错了那就再执行一遍。😊

```bash
pnpm db:init
```

### 5. 创建并上传课程数据

**只有第一次初始化数据库后需要执行**。

```bash
pnpm db:upload
```

### 6. 启动后端服务

```bash
pnpm dev:serve
```

### 7. 启动前端服务

```bash
pnpm dev:client
```

## 🩺 排障：relation "xxx" does not exist

后端启动和 `dev:serve` 都**不会自动建表**，所以看到下面这类报错时，基本都是数据库是空的（或者连到了别的库）：

```
ERROR [ExceptionsHandler] relation "user_course_progress" does not exist
```

修复顺序：

```bash
pnpm docker:start   # 起 db / testdb
pnpm db:init        # 按 schema 建表（drizzle-kit push）
pnpm db:upload      # 只有第一次建库需要：导入星荣课程数据
pnpm dev:serve      # 重新启动后端
```

从本版本起，Postgres 数据持久化在 compose 声明的 `db-data` / `testdb-data` 命名卷里（挂载点为容器内真实的 PGDATA 路径 `/var/lib/postgresql/data`），容器重建不会再丢数据；早先的写法把卷挂到了 `/var/lib/postgres/main-data`，那个路径 Postgres 根本不读，数据其实一直写在匿名卷里，容器一重建就归零。

排查用的只读命令：

```bash
docker compose ls
docker inspect english-for-fun-db-1 --format "{{json .Mounts}}"   # 看真实挂载点
docker volume ls                                                  # 看命名卷 / 匿名卷

# 注意：不要执行 docker volume prune
# 它会连带删掉所有未被引用的卷（包括历史遗留的数据库数据卷），数据不可恢复
```

若 API 启动时直接报 “数据库表缺失：...”，说明自检没通过，按提示跑上面几条命令即可；这类错误现在会在启动阶段一次性暴露，而不是每个请求都 500。

## 🛠️ 关于测试

**提交 commit 前先跑测试，测试通过后再提交代码，以免产生多次 commit 来解决测试问题的情况出现**。

### 前端测试

主要就是 Vitest 的单测以及 cypress 的自动化测试，执行以下命令：

```bash
# 进入前端项目目录
cd apps/client

# vitest
pnpm test:unit:run
# cypress
pnpm test:e2e:run

# 监听 vitest，方便热更新看测试结果
pnpm test:unit:watch
```

### 后端测试

主要就是 Jest 的单测和端对端测试，但需要接入测试的数据库，所以需要先确保：

1. Docker Compose 中的 testdb 服务正常启动。
2. `.env.test` 文件中的配置信息是正确的，如果没有这个文件，可以复制 `apps/api/.env.test.example` 文件内容到 `apps/api/.env.test` 文件，下面有提供命令直接用。

执行以下命令：

```bash
# 进入后端项目目录
cd apps/api

# 如果有 .env.test 文件，就不需要跑这一步了
cp .env.test.example .env.test

# 单测
pnpm test:unit
# 端对端测试
pnpm test:e2e
# 单测和端对端测试一起跑
pnpm test
```

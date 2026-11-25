# 本地开发环境账号密码速查

以下均为 `docker-compose.yml` 中的本地默认值，仅限开发环境，生产环境不要使用（生产数据库和 OSS 凭证走各自的 `.env` 配置）。
所有端口都只在 `127.0.0.1` 上暴露（`db` / `testdb` / `minio` 除外，见各自说明），不要直接暴露到公网。

## 端口总表

| 服务                | 宿主端口  | 说明                                    |
| ------------------- | --------- | --------------------------------------- |
| PostgreSQL（开发）  | 5433      | `db`                                    |
| PostgreSQL（测试）  | 5480      | `testdb`，需 `--profile test`           |
| MinIO S3 API        | 9000      | dev 对象存储                            |
| MinIO Console       | 9001      | dev 对象存储面板                        |
| Langfuse Web UI     | 3002      | 3000 留给 Nuxt dev                      |
| Langfuse Worker     | 3030      | 队列消费                                |
| Langfuse ClickHouse | 8124      | HTTP 接口（9000 原生协议不映射）        |
| Langfuse MinIO      | 9095/9096 | S3 API / Console，与 dev MinIO 分开     |
| Langfuse Redis      | 6380      | 队列 + 缓存                             |
| Langfuse PostgreSQL | 5454      | 用户 / 项目 / API Key / 数据集 / 提示词 |

## PostgreSQL

| 服务             | 主机端口 | 用户名   | 密码     | 数据库         |
| ---------------- | -------- | -------- | -------- | -------------- |
| db（开发库）     | 5433     | postgres | password | earthworm      |
| testdb（测试库） | 5480     | test     | password | earthworm_test |

连接示例：

```bash
# 开发库
psql -h localhost -p 5433 -U postgres -d earthworm

# 或直接起 psql 交互终端
docker compose exec db psql -U postgres -d earthworm
```

```text
postgresql://postgres:password@localhost:5433/earthworm
postgresql://test:password@localhost:5480/earthworm_test
```

## MinIO（dev 对象存储）

| 项目                | 值                                       |
| ------------------- | ---------------------------------------- |
| 管理面板（Console） | http://localhost:9001                    |
| S3 API 端点         | http://localhost:9000                    |
| 账号                | `MINIO_ROOT_USER`，默认 `minioadmin`     |
| 密码                | `MINIO_ROOT_PASSWORD`，默认 `minioadmin` |

账号密码可在根目录 `.env` 中通过 `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` 覆盖；改动后需重建 minio 容器生效。

面板里常用操作：浏览 `earthworm` 桶（私有，匿名访问已关闭）、查 `tts/` 前缀的 30 天过期规则、创建 service account。

## Langfuse（本地追踪栈）

已并入根 `docker-compose.yml`，随 `pnpm docker:start` / `stop` / `down` 一起管理，不再单独挂在 profile 上。

```bash
pnpm docker:start   # 起 db/minio + 整套 Langfuse
pnpm docker:stop    # 停
pnpm docker:down    # 删容器（数据卷保留）
pnpm docker:logs    # 跟全部容器日志
```

首次启动要做 ClickHouse / PG 迁移，`langfuse-web` 大约 **1～3 分钟**才健康，这期间访问会 502，属正常。
整套 Langfuse 常驻约 **2G 内存**（web 2g 上限、worker 1.5g、clickhouse 1.5g、其余各 300-500m），
机器内存紧张时 `docker:start` 之后要留意 clickhouse 有没有被 OOMKill。

### 面板与登录

| 项目      | 值                                  |
| --------- | ----------------------------------- |
| 地址      | http://localhost:3002               |
| 邮箱      | `dev@local.test`                    |
| 密码      | `langfuse1234`                      |
| 组织/项目 | `Earthworm` / `forge`（起来就存在） |

`LANGFUSE_INIT_*` 已预置好组织、项目、key 和账号，**不需要**去 UI 注册、建项目、拷 key。

### API Key

| Key        | 值                                           |
| ---------- | -------------------------------------------- |
| Public Key | `pk-lf-11111111-1111-1111-1111-111111111111` |
| Secret Key | `sk-lf-22222222-2222-2222-2222-222222222222` |

这两个值同时写在 `apps/api/.env` / `.env.example` 的 `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` 里，起栈后直接跑任务就能在 UI 看到 trace。
`LANGFUSE_*` 任一留空 = 整条追踪链路自动禁用（fail-open，不影响流水线）。

### 子组件账号（排查时才用）

| 组件               | 端口        | 账号 / 密码                 |
| ------------------ | ----------- | --------------------------- |
| PostgreSQL         | 5454        | `postgres` / `langfusepg`   |
| ClickHouse         | 8124        | `clickhouse` / `langfusech` |
| Redis              | 6380        | 密码 `langfuserd`           |
| MinIO（S3 / 面板） | 9095 / 9096 | `minio` / `langfuseminio`   |

```bash
# 查 ClickHouse 里落库的事件（v4 下 traces/observations 表恒为 0，真实数据在 events_*）
docker compose exec langfuse-clickhouse clickhouse-client \
  --user clickhouse --password langfusech \
  -q "SELECT type, name, session_id, environment FROM events_full ORDER BY timestamp DESC LIMIT 20"

# 查队列积压
docker compose exec langfuse-redis redis-cli -a langfuserd --no-auth-warning keys 'bull:*'
```

### 已知坑

- **不要用 `GET /api/public/traces` 判断接入是否成功**。Langfuse v4 是 events-only 模式，该接口直接返回 “not available on deployments running in Langfuse v4 events_only mode”，`traces` / `observations` 表也是空的。**去 UI 看**。
- `langfuse-web` 首次迁移会吃掉较多 JS 堆内存，compose 里已设 `NODE_OPTIONS=--max-old-space-size=1280` + `mem_limit: 2g`；若整机内存紧，先关掉别的容器再起。
- ClickHouse 官方 entrypoint 不认 `--max_server_memory_usage` 命令行参数，内存只能靠 `mem_limit` 兜（现为 1500m）。
- 默认口令全是本地弱值。若要给局域网/公网访问，先在根 `.env` 覆盖 `LANGFUSE_PG_PASSWORD` / `LANGFUSE_CLICKHOUSE_PASSWORD` / `LANGFUSE_REDIS_AUTH` / `LANGFUSE_MINIO_PASSWORD` / `LANGFUSE_SALT` / `LANGFUSE_NEXTAUTH_SECRET` / `LANGFUSE_ENCRYPTION_KEY`（后者用 `openssl rand -hex 32` 生成）再启动。
- 要彻底重置（例如 key 对不上、迁移中断）：`pnpm docker:down && docker-compose rm -f && docker volume rm english-for-fun_langfuse_*`，或直接 `docker compose down -v`（连 db/minio 的数据卷一起删，慎用）。
- 现在 Langfuse 与 dev 的 db/minio 同进同出，只想跑 `db` + `minio` 时用 `docker compose up -d db minio`（注意 `minio-init` 也要带上才建桶）。

### 线上

ECS 是 2 核 2G，跑不动这套（官方单机建议 4C16G）。**线上不部署 Langfuse**，`apps/api` 直接出站写 `cloud.langfuse.com`，只在 `apps/api/deploy/.env.prod` 填 `LANGFUSE_*`。详见 `README.env.prod.md`。

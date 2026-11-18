# 本地开发环境账号密码速查

以下均为 `docker-compose.yml` 中的本地默认值，仅限开发环境，生产环境不要使用（生产数据库和 OSS 凭证走各自的 `.env` 配置）。

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

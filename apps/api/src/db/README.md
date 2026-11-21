# 数据库连接与迁移

Drizzle ORM + Postgres。原 `packages/db` 已合并进 `apps/api`。

## 内容

- 运行时连接：`src/common/db.ts`（`setupDB`，读 `DATABASE_URL`，启动自检必需表）。
- 迁移入口：`src/db/migrate.ts`（独立连接，跑 `apps/api/drizzle/` 下的 SQL 迁移；不复用 setupDB，避免缺表自检拦住空库）。
- 迁移产物：`apps/api/drizzle/`（drizzle-kit 生成的 SQL + meta/\_journal.json）。
- 配置：`apps/api/drizzle.config.ts`（正式库，读 `.env`）/ `drizzle.config.test.ts`（测试库，读 `.env.test`，override 自动加载的 `.env`）。schema 指向保留包 `packages/schema/src/schema/*`。

## 常用命令（仓库根目录）

```bash
pnpm db:init          # schema 构建 + drizzle-kit push 建表（开发主用）
pnpm db:init:test     # 对测试库 push
pnpm db:init:test:ci  # 跑 drizzle/ 迁移文件（migrate，幂等）
pnpm db:studio        # drizzle-kit studio 可视化看库
pnpm db:upload        # 导入星荣课程数据（见 @earthworm/xingrong-courses）
```

api 包内脚本：`db:push`、`db:push:test`、`db:migrate`、`db:generate`（生成迁移）、`db:studio`。

> 后端启动**不会自动建表**；看到 `relation "xxx" does not exist` 时先 `pnpm docker:start && pnpm db:init`。详见根目录 README 的排障章节。
>
> 注意：push 与 migrate 是两套建表机制。migrate 过的库（有 `drizzle.__drizzle_migrations` 记账表）再跑 push 会试图删除 drizzle schema 而报错；同一库固定用一种机制。

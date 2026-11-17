# @earthworm/db（数据库连接与迁移）

Drizzle ORM 的 Postgres 连接实例与建表/迁移脚本，是后端与课程数据导入共用的一层。

## 内容

- `src/db.ts`：创建 `postgres` 连接 + `drizzle` 实例（schema 来自 `@earthworm/schema`）。连接串读 `DATABASE_URL`，env 文件按 `NODE_ENV` 从 `apps/api/.env.prod` / `apps/api/.env` 加载。
- `src/migrate.ts`：CI 用的迁移入口，跑 `drizzle/` 目录下的 SQL 迁移文件。
- `drizzle/`：drizzle-kit 生成的迁移产物。
- `drizzle.config.ts` / `drizzle.config.test.ts`：正式库 / 测试库两套配置。

## 常用命令（仓库根目录）

```bash
pnpm db:init          # schema 构建 + drizzle-kit push 建表（开发主用）
pnpm db:init:test     # 对测试库 push
pnpm db:init:test:ci  # CI：跑 drizzle/ 迁移文件
pnpm db:studio        # drizzle-kit studio 可视化看库
pnpm db:upload        # 导入星荣课程数据（见 @earthworm/xingrong-courses）
```

包内脚本：`init`（push）、`init:test`、`init:ci`（migrate）、`generate`（生成迁移）、`migrate`（执行迁移）、`db:studio`。

> 后端启动**不会自动建表**；看到 `relation "xxx" does not exist` 时先 `pnpm docker:start && pnpm db:init`。详见根目录 README 的排障章节。

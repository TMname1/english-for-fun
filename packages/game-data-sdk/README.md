# @earthworm/game-data-sdk（课程数据 SDK）

课程包数据访问层：把「创建课程包（含句子与时间戳）」等写库逻辑封装成可复用函数，供后端 API 与脚本使用。依赖 `@earthworm/schema` + drizzle-orm，tsup 构建。

## 用法

```ts
import { createCoursePack, setupGameDataSDK } from "@earthworm/game-data-sdk";

setupGameDataSDK({ dataBaseURL: process.env.DATABASE_URL! });

const { coursePackId } = await createCoursePack({
  title: "老友记 S01E01",
  description: "……",
  cover: "",
  video: "/course-video/xxx.mp4", // 可选，站内视频 URL
  courses: {
    statements: [
      {
        english: "Can I get a coffee?",
        chinese: "能给我来杯咖啡吗？",
        phonetic: "…",
        startTime: 12.34,
        endTime: 14.56,
        words: [{ word: "Can", start: 12.34, end: 12.5 }],
      },
    ],
  },
});
```

## 导出

- `setupGameDataSDK({ dataBaseURL })`：初始化数据库连接（必须先调用）。
- `createCoursePack(info)`：事务内创建课程包 + 全部句子（自动计算 order，写入 `startTime`/`endTime`/`words` 时间戳），返回 `{ coursePackId }`。
- `updateCoursePack(coursePackId, info)`：更新课程包元信息并重建句子。
- `deleteCoursePack(coursePackId)`：删除课程包及其句子。
- `db`：drizzle 实例（需要自定义查询时用）。
- 类型：`CreateCoursePack`、`Course`、`Statement`、`WordTiming`（`course-pack.model.ts`）。

## 命令

```bash
pnpm sdk:build                    # 根目录：先构建 schema 再构建本包
pnpm -F @earthworm/game-data-sdk test   # vitest（需 .env.test 指向测试库）
```

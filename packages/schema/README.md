# @earthworm/schema（数据库表结构）

全部 Drizzle ORM 表定义的单一事实来源，被 `@earthworm/game-data-sdk`、后端 API（含内置的数据库迁移）共同依赖。用 tsup 构建为 CJS + 类型声明。

## 表一览（`src/schema/`）

| 文件                        | 表                         | 说明                                                                                            |
| --------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------- |
| `coursePack.ts`             | `course_packs`             | 课程包：标题/描述/封面/排序，`video` 字段存站内视频 URL                                         |
| `statement.ts`              | `statements`               | 句子：中英文、音标、排序；`start_time`/`end_time`/`words` 视频时间戳（逐词时间戳供高亮与 seek） |
| `courseHistory.ts`          | `course_history`           | 课程完成历史                                                                                    |
| `userCourseProgress.ts`     | `user_course_progress`     | 用户当前学习进度（课程包 + statement 位置）                                                     |
| `userLearningActivities.ts` | `user_learning_activities` | 按日学习时长                                                                                    |
| `masteredElements.ts`       | `mastered_elements`        | 已掌握单词                                                                                      |

导出：`export * from "./schema"` 逐表导出，另有 `schemas` 命名空间整体导出（drizzle 实例用）。

## 命令

```bash
pnpm schema:build   # 根目录：tsup 构建到 dist/
pnpm -F @earthworm/schema build
```

改表结构后需要 `pnpm db:init`（drizzle-kit push）应用到本地库；`dev:serve` / `build:server` 会自动先构建本包。

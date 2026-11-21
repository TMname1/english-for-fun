# @earthworm/xingrong-courses（示例课程数据）

内置示例课程「星荣零基础学英语」的数据与导入脚本，首次初始化数据库后跑一次即可。

## 内容

- `data/courses/01.json、02.json……`：课程句子数据（每个文件一批 statement）。
- `src/seed.ts`：导入脚本。**会先清空 `statements` 与 `course_packs` 两张表**，再把所有数据文件按文件名顺序串成单一课程包的一条 statement 链（「分课程」功能已删除，整个星荣课程是一个课程包）。

## 用法

```bash
# 仓库根目录，需先 pnpm docker:start && pnpm db:init
pnpm db:upload
```

> ⚠️ 重复执行会清空并重建课程包数据（包括你后来导入的自定义课程包），只在首次初始化或明确想重置时使用。

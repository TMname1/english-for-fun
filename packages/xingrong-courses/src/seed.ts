import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { coursePack, schemas, statement as statementSchema } from "@earthworm/schema";

dotenv.config({ path: path.resolve(__dirname, "../../../apps/api/.env") });
const db = drizzle(postgres(process.env.DATABASE_URL ?? ""), { schema: schemas });

type Statement = typeof statementSchema.$inferInsert;

const courseFiles = fs.readdirSync(path.resolve(__dirname, "../data/courses")).sort();

/**
 * "分课程"功能已删除：整个星荣课程导入为单一课程包，
 * 各数据文件（01.json、02.json……）的句子按文件名顺序串成一条 statement 链。
 */
(async function () {
  await db.delete(statementSchema);
  await db.delete(coursePack);

  const [coursePackEntity] = await db
    .insert(coursePack)
    .values({
      order: 1,
      title: "星荣零基础学英语",
      description: "最适合零基础入门的课程",
      cover:
        "https://earthworm-prod-1312884695.cos.ap-beijing.myqcloud.com/course-packs/xingrong.jpg",
    })
    .returning();

  let order = 1;
  for (const courseFileName of courseFiles) {
    const courseDataJsonText = fs.readFileSync(
      path.resolve(__dirname, `../data/courses/${courseFileName}`),
      "utf-8",
    );

    const statementList = JSON.parse(courseDataJsonText) as Statement[];

    await Promise.all(
      statementList.map(async (statement) => {
        return await db.insert(statementSchema).values({
          ...statement,
          order: order++,
          coursePackId: coursePackEntity.id,
        });
      }),
    );

    console.log(`上传完成: ${courseFileName}（累计 ${order - 1} 句）`);
  }

  console.log("全部创建完成");
  process.exit(0);
})();

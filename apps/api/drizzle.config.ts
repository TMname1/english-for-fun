import path from "path";
import type { Config } from "drizzle-kit";

import * as dotenv from "dotenv";

// 与 src/global/global.module.ts 一致：按 NODE_ENV 选择 env 文件
const envFiles: Record<string, string> = { prod: ".env.prod", test: ".env.test" };
dotenv.config({ path: path.resolve(__dirname, envFiles[process.env.NODE_ENV ?? ""] ?? ".env") });

console.log("process.env.DATABASE_URL: ", process.env.DATABASE_URL);

export default {
  schema: "../../packages/schema/src/schema/*",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL || "",
  },
} satisfies Config;

import path from "path";
import type { Config } from "drizzle-kit";

import * as dotenv from "dotenv";

// drizzle-kit 会先自动加载 cwd 的 .env，必须 override 才能让 .env.test 生效
dotenv.config({ path: path.resolve(__dirname, ".env.test"), override: true });

export default {
  schema: "../../packages/schema/src/schema/*",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL || "",
  },
} satisfies Config;

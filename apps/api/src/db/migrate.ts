import { resolve } from "node:path";

import dotenv from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { schemas } from "@earthworm/schema";

// 独立连接：不复用 common/db.ts 的 setupDB，其缺表自检会在空库上先抛错
const envFiles: Record<string, string> = { prod: ".env.prod", test: ".env.test" };
dotenv.config({
  path: resolve(process.cwd(), envFiles[process.env.NODE_ENV ?? ""] ?? ".env"),
});

const connection = postgres(process.env.DATABASE_URL ?? "", { max: 1 });
const db = drizzle(connection, { schema: schemas });

migrate(db, { migrationsFolder: resolve(process.cwd(), "drizzle") })
  .then(() => {
    console.log("Woohoo! Migrations completed!");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

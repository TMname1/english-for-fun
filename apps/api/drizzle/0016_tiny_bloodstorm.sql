CREATE TABLE IF NOT EXISTS "bili_cookie" (
	"id" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp
);

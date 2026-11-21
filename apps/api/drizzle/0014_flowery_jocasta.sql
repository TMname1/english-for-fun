ALTER TABLE "statements" ADD COLUMN "start_time" double precision;--> statement-breakpoint
ALTER TABLE "statements" ADD COLUMN "end_time" double precision;--> statement-breakpoint
ALTER TABLE "statements" ADD COLUMN "words" jsonb;
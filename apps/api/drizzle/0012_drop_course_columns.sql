ALTER TABLE "statements" DROP CONSTRAINT "statements_course_id_courses_id_fk";--> statement-breakpoint
ALTER TABLE "course_history" DROP CONSTRAINT "course_history_course_id_course_pack_id_unique";--> statement-breakpoint
DROP TABLE "courses";--> statement-breakpoint
ALTER TABLE "course_packs" ADD COLUMN "video" text DEFAULT '';--> statement-breakpoint
ALTER TABLE "course_history" DROP COLUMN IF EXISTS "course_id";--> statement-breakpoint
ALTER TABLE "statements" DROP COLUMN IF EXISTS "course_id";--> statement-breakpoint
ALTER TABLE "user_course_progress" DROP COLUMN IF EXISTS "course_id";--> statement-breakpoint
ALTER TABLE "user_learning_activities" DROP COLUMN IF EXISTS "course_id";--> statement-breakpoint
ALTER TABLE "course_history" ADD CONSTRAINT "course_history_course_pack_id_unique" UNIQUE("course_pack_id");

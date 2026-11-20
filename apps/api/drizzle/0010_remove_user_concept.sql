-- 项目改为单实例学习应用：清空旧的多用户学习记录，移除 user_id 等用户概念字段
TRUNCATE TABLE "user_course_progress", "course_history", "user_learning_activities", "mastered_elements" RESTART IDENTITY CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "memberships" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "user_learn_record" CASCADE;--> statement-breakpoint
ALTER TABLE "user_course_progress" DROP CONSTRAINT IF EXISTS "user_course_progress_user_id_course_pack_id_unique";--> statement-breakpoint
ALTER TABLE "user_course_progress" DROP COLUMN IF EXISTS "user_id";--> statement-breakpoint
ALTER TABLE "user_course_progress" ADD CONSTRAINT "user_course_progress_course_pack_id_unique" UNIQUE("course_pack_id");--> statement-breakpoint
ALTER TABLE "course_history" DROP CONSTRAINT IF EXISTS "course_history_user_id_course_id_course_pack_id_unique";--> statement-breakpoint
ALTER TABLE "course_history" DROP COLUMN IF EXISTS "user_id";--> statement-breakpoint
ALTER TABLE "course_history" ADD CONSTRAINT "course_history_course_id_course_pack_id_unique" UNIQUE("course_id","course_pack_id");--> statement-breakpoint
ALTER TABLE "user_learning_activities" DROP CONSTRAINT IF EXISTS "user_learning_activities_user_id_date_activity_type_unique";--> statement-breakpoint
ALTER TABLE "user_learning_activities" DROP COLUMN IF EXISTS "user_id";--> statement-breakpoint
ALTER TABLE "user_learning_activities" ADD CONSTRAINT "user_learning_activities_date_activity_type_unique" UNIQUE("date","activity_type");--> statement-breakpoint
ALTER TABLE "mastered_elements" DROP COLUMN IF EXISTS "user_id";--> statement-breakpoint
ALTER TABLE "course_packs" DROP COLUMN IF EXISTS "is_free";--> statement-breakpoint
ALTER TABLE "course_packs" DROP COLUMN IF EXISTS "creator_id";--> statement-breakpoint
ALTER TABLE "course_packs" DROP COLUMN IF EXISTS "share_level";

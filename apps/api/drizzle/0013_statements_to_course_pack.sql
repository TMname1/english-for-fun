ALTER TABLE "statements" ADD COLUMN "course_pack_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "user_learning_activities" ADD COLUMN "course_pack_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "statements" ADD CONSTRAINT "statements_course_pack_id_course_packs_id_fk" FOREIGN KEY ("course_pack_id") REFERENCES "public"."course_packs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

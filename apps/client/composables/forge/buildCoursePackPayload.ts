import type { CreateCoursePackPayload } from "~/api/course-pack";
import type { ForgeJobView } from "~/api/forge";

/** 流水线 done 产物 → 课程包入库 payload；video 指向原视频，statement 时间戳为绝对时间 */
export function buildCoursePackPayload(j: ForgeJobView): CreateCoursePackPayload {
  const data = j.courseJson;
  if (!data) throw new Error("产物缺失，无法导入");
  const payload: CreateCoursePackPayload = {
    title: (data.title || j.title || "").trim(),
    description: (data.description || j.description || "").trim(),
    cover: data.cover ?? "",
    video: j.videoPath || undefined,
    courses: {
      title: data.courses?.title ?? data.title ?? j.title,
      description: data.courses?.description ?? "",
      statements: (data.courses?.statements ?? []).map((s) => ({
        english: (s.english ?? "").trim(),
        chinese: (s.chinese ?? "").trim(),
        phonetic: (s.phonetic ?? "").trim(),
        startTime: s.startTime ?? undefined,
        endTime: s.endTime ?? undefined,
        words: s.words && s.words.length > 0 ? s.words : undefined,
      })),
    },
  };
  if (!payload.title) throw new Error("缺少课程包标题");
  if (payload.courses.statements.length === 0) throw new Error("句子列表为空，无法导入");
  return payload;
}

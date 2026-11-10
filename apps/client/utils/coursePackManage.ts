import type { CreateCoursePackPayload, CreateCoursePackStatement } from "~/api/course-pack";

export interface CourseForm {
  title: string;
  description: string;
  /** 句子列表的 JSON 文本：[{ english, chinese, phonetic? }] */
  statementsText: string;
}

export interface PackForm {
  title: string;
  description: string;
  cover: string;
}

export type ParseResult =
  | { ok: true; statements: CreateCoursePackStatement[] }
  | { ok: false; error: string };

export type BuildResult =
  | { ok: true; payload: CreateCoursePackPayload }
  | { ok: false; error: string };

const FAIL = (error: string): { ok: false; error: string } => ({ ok: false, error });

export function parseStatementsJson(text: string): ParseResult {
  const trimmed = text.trim();
  if (!trimmed) return FAIL("句子内容不能为空");

  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return FAIL("句子内容不是合法的 JSON");
  }

  if (!Array.isArray(data)) return FAIL("句子内容必须是数组");
  if (data.length === 0) return FAIL("句子内容至少要有 1 条");

  const statements: CreateCoursePackStatement[] = [];
  for (const [index, item] of data.entries()) {
    if (typeof item !== "object" || item === null) {
      return FAIL(`第 ${index + 1} 条句子必须是对象`);
    }
    const { english, chinese, phonetic } = item as Record<string, unknown>;
    if (typeof english !== "string" || !english.trim()) {
      return FAIL(`第 ${index + 1} 条句子缺少 english 字段`);
    }
    if (typeof chinese !== "string" || !chinese.trim()) {
      return FAIL(`第 ${index + 1} 条句子缺少 chinese 字段`);
    }
    if (phonetic !== undefined && typeof phonetic !== "string") {
      return FAIL(`第 ${index + 1} 条句子的 phonetic 必须是字符串`);
    }
    statements.push({ english, chinese, phonetic: phonetic ?? "" });
  }

  return { ok: true, statements };
}

export function buildCreateCoursePackPayload(pack: PackForm, courses: CourseForm[]): BuildResult {
  if (!pack.title.trim()) return FAIL("课程包标题不能为空");
  if (courses.length === 0) return FAIL("至少需要添加一门课程");

  const builtCourses: CreateCoursePackPayload["courses"] = [];
  for (const [index, course] of courses.entries()) {
    if (!course.title.trim()) return FAIL(`第 ${index + 1} 门课程缺少标题`);

    const parsed = parseStatementsJson(course.statementsText);
    if (!parsed.ok) return FAIL(`第 ${index + 1} 门课程：${parsed.error}`);

    builtCourses.push({
      title: course.title.trim(),
      description: course.description,
      statements: parsed.statements,
    });
  }

  return {
    ok: true,
    payload: {
      title: pack.title.trim(),
      description: pack.description,
      cover: pack.cover,
      courses: builtCourses,
    },
  };
}

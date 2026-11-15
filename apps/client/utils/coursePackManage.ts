import type { CreateCoursePackPayload, CreateCoursePackStatement } from "~/api/course-pack";

/** 课程包内唯一课程的表单（"分课程"功能已删除：不再是课程数组） */
export interface CourseForm {
  title: string;
  description: string;
  /** 结构化句子列表，由 StatementListEditor 组件双向绑定 */
  statements: CreateCoursePackStatement[];
}

export interface PackForm {
  title: string;
  description: string;
  cover: string;
  /** 配套视频：站内路径（/course-video/xxx.mp4）或外部 URL，可为空串 */
  video: string;
}

export type ParseResult =
  | { ok: true; statements: CreateCoursePackStatement[] }
  | { ok: false; error: string };

export type BuildResult =
  | { ok: true; payload: CreateCoursePackPayload }
  | { ok: false; error: string };

export type CourseJsonImportResult =
  | { ok: true; statements: CreateCoursePackStatement[] }
  | { ok: false; error: string };

export type CourseImportResult = { ok: true; course: CourseForm } | { ok: false; error: string };

export type PackImportResult =
  | { ok: true; pack: PackForm; course: CourseForm }
  | { ok: false; error: string };

export const EMPTY_STATEMENT: CreateCoursePackStatement = {
  english: "",
  chinese: "",
  phonetic: "",
};

export function createEmptyCourse(): CourseForm {
  return { title: "", description: "", statements: [] };
}

const FAIL = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** 规范逐词时间戳：接受 { word, start, end }[]，非法条目跳过；空或全非法返回 undefined（不下发） */
function normalizeWords(raw: unknown): CreateCoursePackStatement["words"] {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const words: { word: string; start: number; end: number }[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { word, start, end } = item as Record<string, unknown>;
    const s = toTimingNumber(start);
    const e = toTimingNumber(end);
    if (typeof word !== "string" || !word.trim() || s === undefined || e === undefined) continue;
    words.push({ word: word.trim(), start: s, end: e });
  }
  return words.length > 0 ? words : undefined;
}

/** 把句子数组规范为 CreateCoursePackStatement[]，错误信息带 prefix 前缀 */
function normalizeStatements(rawList: unknown[], prefix = ""): ParseResult {
  const statements: CreateCoursePackStatement[] = [];
  for (const [index, item] of rawList.entries()) {
    if (typeof item !== "object" || item === null) {
      return FAIL(`${prefix}第 ${index + 1} 条句子必须是对象`);
    }
    const { english, chinese, phonetic, soundmark, startTime, endTime, words } = item as Record<
      string,
      unknown
    >;
    if (typeof english !== "string" || !english.trim()) {
      return FAIL(`${prefix}第 ${index + 1} 条句子缺少 english 字段`);
    }
    if (typeof chinese !== "string" || !chinese.trim()) {
      return FAIL(`${prefix}第 ${index + 1} 条句子缺少 chinese 字段`);
    }
    const normalizedPhonetic = phonetic ?? soundmark ?? "";
    if (typeof normalizedPhonetic !== "string") {
      return FAIL(`${prefix}第 ${index + 1} 条句子的音标字段必须是字符串`);
    }
    const statement: CreateCoursePackStatement = { english, chinese, phonetic: normalizedPhonetic };
    const start = toTimingNumber(startTime);
    const end = toTimingNumber(endTime);
    if (start !== undefined) statement.startTime = start;
    if (end !== undefined) statement.endTime = end;
    const normalizedWords = normalizeWords(words);
    if (normalizedWords) statement.words = normalizedWords;
    statements.push(statement);
  }

  return { ok: true, statements };
}

/**
 * 把课程包 JSON 里的单一课程规范成表单结构（audioUrl 等多余字段会被丢弃）。
 * title/description 可选：入库的只有 statements。
 */
function normalizeImportedCourse(item: unknown, label = "课程"): CourseImportResult {
  if (typeof item !== "object" || item === null) return FAIL(`${label}必须是对象`);

  const { title, description, statements } = item as Record<string, unknown>;
  if (title !== undefined && (typeof title !== "string" || !title.trim())) {
    return FAIL(`${label}的 title 必须是非空字符串`);
  }
  if (description !== undefined && typeof description !== "string") {
    return FAIL(`${label}的 description 必须是字符串`);
  }
  if (!Array.isArray(statements)) return FAIL(`${label}的 statements 必须是句子数组`);
  if (statements.length === 0) return FAIL(`${label}至少要有 1 个句子`);

  const normalized = normalizeStatements(statements, `${label}：`);
  if (!normalized.ok) return normalized;

  return {
    ok: true,
    course: {
      title: typeof title === "string" ? title.trim() : "",
      description: description ?? "",
      statements: normalized.statements,
    },
  };
}

/**
 * 解析导入的句子文件内容。
 * 兼容两种句子格式：
 * - 接口格式：[{ english, chinese, phonetic? }]
 * - xingrong 课程格式：[{ english, chinese, soundmark? }]（soundmark 会被规范为 phonetic）
 */
export function parseCourseJsonImport(fileText: string): CourseJsonImportResult {
  const trimmed = fileText.trim();
  if (!trimmed) return FAIL("文件内容为空");

  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return FAIL("文件内容不是合法的 JSON");
  }

  if (!Array.isArray(data)) return FAIL("句子文件顶层必须是句子数组");
  if (data.length === 0) return FAIL("句子数组至少要有 1 个句子");

  return normalizeStatements(data);
}

/**
 * 解析完整课程包 JSON（Course Forge 产物格式）：
 * { title, description?, cover?, courses: { title?, description?, statements } }
 */
export function parseCoursePackJsonImport(fileText: string): PackImportResult {
  const trimmed = fileText.trim();
  if (!trimmed) return FAIL("文件内容为空");

  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return FAIL("文件内容不是合法的 JSON");
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return FAIL("完整课程包 JSON 顶层必须是对象（含 title 与 courses）");
  }

  const { title, description, cover, video, courses: rawCourses } = data as Record<string, unknown>;
  if (typeof title !== "string" || !title.trim()) return FAIL("课程包 JSON 缺少 title");
  if (description !== undefined && typeof description !== "string") {
    return FAIL("课程包 JSON 的 description 必须是字符串");
  }
  if (cover !== undefined && typeof cover !== "string") {
    return FAIL("课程包 JSON 的 cover 必须是字符串");
  }
  if (video !== undefined && typeof video !== "string") {
    return FAIL("课程包 JSON 的 video 必须是字符串");
  }
  if (Array.isArray(rawCourses)) {
    return FAIL("课程包 JSON 的 courses 必须是单一课程对象，不再支持课程数组");
  }
  if (typeof rawCourses !== "object" || rawCourses === null) {
    return FAIL("课程包 JSON 缺少 courses 课程对象");
  }

  const courseResult = normalizeImportedCourse(rawCourses, "courses");
  if (!courseResult.ok) return courseResult;

  return {
    ok: true,
    pack: {
      title: title.trim(),
      description: description ?? "",
      cover: cover ?? "",
      video: video ?? "",
    },
    course: courseResult.course,
  };
}

/** 把视频时间戳字段规范成 number|undefined：接受 number 或可解析字符串，空/NaN 视为未填 */
function toTimingNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const num = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(num) ? num : undefined;
}

/** 校验列表编辑器输出的句子数组：非空 + 必填字段齐备；顺带 trim、默认 phonetic 与保留视频时间戳 */
export function validateStatements(list: CreateCoursePackStatement[]): ParseResult {
  if (list.length === 0) return FAIL("句子列表不能为空");

  const statements: CreateCoursePackStatement[] = [];
  for (const [index, item] of list.entries()) {
    const english = item.english?.trim() ?? "";
    const chinese = item.chinese?.trim() ?? "";
    if (!english) return FAIL(`第 ${index + 1} 条句子缺少 english 字段`);
    if (!chinese) return FAIL(`第 ${index + 1} 条句子缺少 chinese 字段`);
    const phonetic = item.phonetic ?? "";
    if (typeof phonetic !== "string") {
      return FAIL(`第 ${index + 1} 条句子的 phonetic 必须是字符串`);
    }
    const statement: CreateCoursePackStatement = { english, chinese, phonetic };
    const startTime = toTimingNumber(item.startTime);
    const endTime = toTimingNumber(item.endTime);
    if (startTime !== undefined) statement.startTime = startTime;
    if (endTime !== undefined) statement.endTime = endTime;
    if (item.words && item.words.length > 0) statement.words = item.words;
    statements.push(statement);
  }

  return { ok: true, statements };
}

export function buildCreateCoursePackPayload(pack: PackForm, course: CourseForm): BuildResult {
  if (!pack.title.trim()) return FAIL("课程包标题不能为空");

  const validated = validateStatements(course.statements);
  if (!validated.ok) return FAIL(`课程：${validated.error}`);

  const video = pack.video?.trim() ?? "";

  return {
    ok: true,
    payload: {
      title: pack.title.trim(),
      description: pack.description,
      cover: pack.cover,
      video,
      courses: {
        title: course.title.trim() || undefined,
        description: course.description,
        statements: validated.statements,
      },
    },
  };
}

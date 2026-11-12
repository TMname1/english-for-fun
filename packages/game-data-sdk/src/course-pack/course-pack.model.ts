export interface Statement {
  english: string;
  phonetic: string;
  chinese: string;
  /** 真实音频切片路径（如 /course-audio/xxx.mp3），可选；缺省时播放 TTS */
  audioUrl?: string | null;
}

/**
 * 课程包内的单一课程（"分课程"功能已删除：不再是数组）。
 * title/description 仅作为 course.json 产物里的可读文案，入库的只有 statements。
 */
export interface Course {
  title?: string;
  description?: string;
  statements: Statement[];
}

export interface CreateCoursePack {
  title: string;
  description: string;
  cover: string;
  courses: Course;
}

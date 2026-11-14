export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

export interface Statement {
  english: string;
  phonetic: string;
  chinese: string;
  /** 真实音频切片路径（如 /course-audio/xxx.mp3），可选；缺省时播放 TTS */
  audioUrl?: string | null;
  /** 配套视频中的起点（秒），可选；与 endTime 一起用于视频 seek 播放 */
  startTime?: number | null;
  /** 配套视频中的终点（秒），可选 */
  endTime?: number | null;
  /** 逐词时间戳，可选；ASR 段级降级时为 null */
  words?: WordTiming[] | null;
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
  /** 配套视频链接（站内路径如 /course-video/xxx.mp4，或外部 URL），可选 */
  video?: string;
  courses: Course;
}

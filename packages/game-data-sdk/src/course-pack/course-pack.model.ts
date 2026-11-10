export interface Statement {
  english: string;
  phonetic: string;
  chinese: string;
}

interface Course {
  title: string;
  description: string;
  statements: Statement[];
  learningContent?: string;
}

export interface CreateCoursePack {
  title: string;
  description: string;
  cover: string;
  courses: Course[];
}

type UpdateCourse = Course & { publishCourseId: string };

export interface UpdateCoursePack {
  title: string;
  description: string;
  cover: string;
  courses: UpdateCourse[];
}

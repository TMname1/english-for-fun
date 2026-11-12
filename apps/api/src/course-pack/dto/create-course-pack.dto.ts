import { Type } from "class-transformer";
import {
  ArrayNotEmpty,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from "class-validator";

export class StatementDto {
  @IsString()
  @IsNotEmpty()
  english: string;

  @IsString()
  @IsNotEmpty()
  chinese: string;

  @IsString()
  @IsOptional()
  phonetic?: string;

  /** 真实音频切片路径（如 /course-audio/xxx.mp3），可选；缺省时播放 TTS */
  @IsString()
  @IsOptional()
  audioUrl?: string;
}

export class CourseDto {
  /**
   * 单一课程对象（原 courses 数组已随"分课程"功能删除）。
   * title/description 仅为 course.json 校对文案，入库的只有 statements。
   */
  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => StatementDto)
  statements: StatementDto[];
}

export class CreateCoursePackDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  cover?: string;

  @ValidateNested()
  @Type(() => CourseDto)
  courses: CourseDto;
}

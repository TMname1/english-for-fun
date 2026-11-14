import { Type } from "class-transformer";
import {
  ArrayNotEmpty,
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from "class-validator";

export class StatementWordDto {
  @IsString()
  @IsNotEmpty()
  word: string;

  @IsNumber()
  start: number;

  @IsNumber()
  end: number;
}

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

  /** 配套视频中的起点（秒），可选；与 endTime 一起用于视频 seek 播放 */
  @IsNumber()
  @IsOptional()
  startTime?: number;

  /** 配套视频中的终点（秒），可选 */
  @IsNumber()
  @IsOptional()
  endTime?: number;

  /** 逐词时间戳，可选；ASR 段级降级时缺省 */
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => StatementWordDto)
  words?: StatementWordDto[];
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

  /** 配套视频链接（站内路径如 /course-video/xxx.mp4，或外部 URL），可选 */
  @IsString()
  @IsOptional()
  video?: string;

  @ValidateNested()
  @Type(() => CourseDto)
  courses: CourseDto;
}

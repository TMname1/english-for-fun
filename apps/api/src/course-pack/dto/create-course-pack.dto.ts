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
}

export class CourseDto {
  @IsString()
  @IsNotEmpty()
  title: string;

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

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CourseDto)
  courses: CourseDto[];
}

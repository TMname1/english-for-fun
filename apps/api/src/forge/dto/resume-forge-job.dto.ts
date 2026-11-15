import { Type } from "class-transformer";
import { IsArray, IsNumber, IsOptional, IsString, ValidateNested } from "class-validator";

/** 校对后回传的词：word 文字可改，start/end 沿用原值（只读，不可改） */
export class ResumeForgeWordDto {
  @IsString()
  word: string;

  @IsNumber()
  start: number;

  @IsNumber()
  end: number;
}

/** 校对后保留的分段（被删除的分段不出现在数组里） */
export class ResumeForgeSegmentDto {
  @IsNumber()
  id: number;

  @IsNumber()
  start: number;

  @IsNumber()
  end: number;

  @IsOptional()
  @IsString()
  text?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ResumeForgeWordDto)
  words: ResumeForgeWordDto[];
}

export class ResumeForgeJobDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ResumeForgeSegmentDto)
  segments: ResumeForgeSegmentDto[];
}

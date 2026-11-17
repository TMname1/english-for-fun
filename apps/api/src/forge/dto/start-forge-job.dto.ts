import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsNumber, IsOptional, Min, ValidateNested } from "class-validator";

export class ClipRangeDto {
  @IsNumber()
  @Min(0)
  start: number;

  @IsNumber()
  @Min(0)
  end: number;
}

export class StartForgeJobDto {
  /** 选中的时间区间（秒）；缺省转写整段。须升序、互不重叠、每段 ≥ 0.1s */
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ClipRangeDto)
  @IsOptional()
  clips?: ClipRangeDto[];
}

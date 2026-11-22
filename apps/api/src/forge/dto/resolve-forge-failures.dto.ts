import { Type } from "class-transformer";
import { IsArray, IsIn, IsNumber, ValidateNested } from "class-validator";

/** 对单个失败句的人工决策：删除（从课程省略）或重试（再生成一次） */
export class ResolveDecisionDto {
  @IsNumber()
  index: number;

  @IsIn(["delete", "retry"])
  action: "delete" | "retry";
}

export class ResolveForgeFailuresDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ResolveDecisionDto)
  decisions: ResolveDecisionDto[];
}

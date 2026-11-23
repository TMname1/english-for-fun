import { Type } from "class-transformer";
import { IsArray, IsIn, IsNumber, ValidateNested } from "class-validator";

/**
 * 对单个失败句的人工决策：
 * delete  删除该句（从课程中省略）
 * retry   重试该句（再生成一次）
 * 注：输出里混着单词行由后端自动删除并重新校验，不是人工决策项。
 */
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

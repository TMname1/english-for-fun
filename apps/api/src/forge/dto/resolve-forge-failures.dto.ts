import { Type } from "class-transformer";
import { IsArray, IsIn, IsNumber, ValidateNested } from "class-validator";

/**
 * 对单个失败句的人工决策：
 * delete       删除该句（从课程中省略）
 * retry        重试该句（再生成一次）
 * strip_words  删除该句输出里的所有单个单词行，剩余内容重新校验（合格即通过）
 */
export class ResolveDecisionDto {
  @IsNumber()
  index: number;

  @IsIn(["delete", "retry", "strip_words"])
  action: "delete" | "retry" | "strip_words";
}

export class ResolveForgeFailuresDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ResolveDecisionDto)
  decisions: ResolveDecisionDto[];
}

import { IsIn, IsNotEmpty, IsOptional, IsString } from "class-validator";

export class CreateForgeJobDto {
  /** 课程包标题 */
  @IsString()
  @IsNotEmpty()
  title: string;

  /** 内容类型：dialogue 对话 / music 音乐 */
  @IsIn(["dialogue", "music"])
  type: "dialogue" | "music";

  /** 描述，留空由流水线生成默认 */
  @IsString()
  @IsOptional()
  desc?: string;

  /** ASR 语言提示；当前仅开放常见三种 */
  @IsIn(["en", "zh", "ja"])
  @IsOptional()
  language?: string;
}

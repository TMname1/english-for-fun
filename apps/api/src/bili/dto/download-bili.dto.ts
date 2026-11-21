import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Min } from "class-validator";

/**
 * B 站链接下载请求：url + 下载参数（qn/p），外加课程包元信息（用于下载完成后建流水线任务）。
 * 仅接受可解析出 BV 号的链接；清晰度用别名或数字 id 字符串（如 "1080" / "80"）。
 */
export class DownloadBiliDto {
  /** BV 号或 B 站视频链接 */
  @IsString()
  @IsNotEmpty()
  url: string;

  /** 课程包标题 */
  @IsString()
  @IsNotEmpty()
  title: string;

  /** 内容类型 */
  @IsIn(["dialogue", "music"])
  type: "dialogue" | "music";

  /** 分 P 序号，默认 1 */
  @IsInt()
  @Min(1)
  @IsOptional()
  p?: number;

  /** 清晰度上限：别名(360/480/720/1080/1080p60/4k/8k) 或数字 id 字符串 */
  @IsString()
  @IsOptional()
  qn?: string;

  /** ASR 语言 */
  @IsIn(["en", "zh", "ja"])
  @IsOptional()
  language?: string;

  /** 描述，留空由流水线生成 */
  @IsString()
  @IsOptional()
  desc?: string;
}

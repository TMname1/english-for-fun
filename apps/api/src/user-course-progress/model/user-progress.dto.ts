import { ApiProperty } from "@nestjs/swagger";
import { IsInt, IsNotEmpty } from "class-validator";

export class UpsertUserProgressDto {
  @ApiProperty()
  @IsNotEmpty({ message: "课程包不能为空" })
  coursePackId: string;

  @ApiProperty()
  @IsNotEmpty({ message: "课程进度不能为空" })
  @IsInt()
  statementIndex: number;
}

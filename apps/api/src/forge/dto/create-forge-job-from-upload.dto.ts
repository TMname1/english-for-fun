import { IsNotEmpty, IsString } from "class-validator";

import { CreateForgeJobDto } from "./create-forge-job.dto";

/**
 * 浏览器已直传完成后的建任务请求（JSON）。
 * videoKey 由 presign 接口下发，服务端会 HeadObject 校验对象确实存在且大小合法。
 */
export class CreateForgeJobFromUploadDto extends CreateForgeJobDto {
  @IsString()
  @IsNotEmpty()
  videoKey: string;
}

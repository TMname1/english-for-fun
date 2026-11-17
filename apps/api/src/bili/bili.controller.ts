import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";

import type { DownloadBiliDto } from "./dto/download-bili.dto";
import { BiliService } from "./bili.service";

@Controller("bili")
export class BiliController {
  constructor(private readonly biliService: BiliService) {}

  /** 读取已保存 cookie 的登录态（未登录/已登录 + 账号 + 大会员） */
  @Get("login/status")
  loginStatus() {
    return this.biliService.loginStatus();
  }

  /** 生成登录二维码，返回 data URL 与轮询 key */
  @Post("login/start")
  loginStart() {
    return this.biliService.loginStart();
  }

  /** 轮询登录结果 */
  @Get("login/poll")
  loginPoll(@Query("key") key: string) {
    return this.biliService.loginPoll(key);
  }

  /** 拉取视频信息与分 P 列表，供前端展示可选 P / 回填标题 */
  @Get("info")
  info(@Query("url") url: string) {
    return this.biliService.info(url);
  }

  /** 发起 B 站下载（后台执行，立即返回 downloadId） */
  @Post("downloads")
  createDownload(@Body() dto: DownloadBiliDto) {
    return this.biliService.startDownload(dto);
  }

  /** 轮询下载进度；status=done 时附带 jobId（defer 流水线任务）与站内视频 URL */
  @Get("downloads/:id")
  getDownload(@Param("id") id: string) {
    return this.biliService.getDownload(id);
  }

  /** 取消进行中的下载 */
  @Post("downloads/:id/cancel")
  cancelDownload(@Param("id") id: string) {
    return this.biliService.cancelDownload(id);
  }
}

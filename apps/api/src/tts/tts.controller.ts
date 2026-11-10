import { Controller, Get, Header, Query, StreamableFile } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";

import { TtsService } from "./tts.service";

@ApiTags("TTS")
@Controller("tts")
export class TtsController {
  constructor(private readonly ttsService: TtsService) {}

  @ApiOperation({
    summary: "英文 TTS 发音（Edge 神经网络语音，带磁盘缓存）",
  })
  @Get()
  @Header("Content-Type", "audio/mpeg")
  @Header("Cache-Control", "public, max-age=31536000, immutable")
  async getAudio(@Query("text") text: string, @Query("accent") accent: string) {
    const audio = await this.ttsService.getAudio(text, accent);
    return new StreamableFile(audio);
  }
}

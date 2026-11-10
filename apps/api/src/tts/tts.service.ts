import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HttpsProxyAgent } from "https-proxy-agent";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

/** Accent (kept in sync with the client's PronunciationType) -> Edge neural voice */
export const ACCENT_VOICE_MAP = {
  American: "en-US-AriaNeural",
  British: "en-GB-SoniaNeural",
} as const;

export type Accent = keyof typeof ACCENT_VOICE_MAP;

const MAX_TEXT_LENGTH = 500;

@Injectable()
export class TtsService implements OnModuleDestroy {
  private readonly logger = new Logger(TtsService.name);
  private readonly storageDir: string;
  private readonly proxyUrl: string | undefined;
  /** Per-voice ready clients, reused across requests to keep the websocket warm */
  private readonly clients = new Map<string, MsEdgeTTS>();
  /** Dedupes concurrent client creation per voice */
  private readonly pendingClients = new Map<string, Promise<MsEdgeTTS>>();
  /** Dedupes concurrent synthesis of the same text, keyed by cache key */
  private readonly inFlight = new Map<string, Promise<Buffer>>();

  constructor(private readonly configService: ConfigService) {
    this.storageDir =
      this.configService.get<string>("TTS_STORAGE_DIR") || join(process.cwd(), "storage", "tts");
    this.proxyUrl = this.configService.get<string>("TTS_PROXY_URL") || undefined;
  }

  async getAudio(text: unknown, accent: unknown): Promise<Buffer> {
    const normalized = typeof text === "string" ? text.trim() : "";
    if (!normalized || normalized.length > MAX_TEXT_LENGTH) {
      throw new BadRequestException(
        `text must be a non-empty string of at most ${MAX_TEXT_LENGTH} characters`,
      );
    }
    const voice = ACCENT_VOICE_MAP[accent as Accent];
    if (!voice) {
      throw new BadRequestException(
        `accent must be one of: ${Object.keys(ACCENT_VOICE_MAP).join(", ")}`,
      );
    }

    const key = this.cacheKey(voice, normalized);
    const cached = await this.readCached(key);
    if (cached) {
      return cached;
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }

    const task = this.synthesize(voice, normalized, key).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, task);
    return task;
  }

  onModuleDestroy() {
    for (const [voice, client] of this.clients) {
      this.destroyClient(voice, client);
    }
    this.clients.clear();
    this.pendingClients.clear();
  }

  private cacheKey(voice: string, text: string): string {
    return createHash("sha256").update(`${voice}|${text}`).digest("hex");
  }

  private async readCached(key: string): Promise<Buffer | null> {
    try {
      return await readFile(join(this.storageDir, `${key}.mp3`));
    } catch {
      return null;
    }
  }

  private async synthesize(voice: string, text: string, key: string): Promise<Buffer> {
    try {
      const client = await this.getClient(voice);
      const { audioStream } = client.toStream(this.escapeSsml(text));
      const audio = await this.collectStream(audioStream);
      if (audio.length === 0) {
        throw new Error("synthesizer returned empty audio");
      }
      await this.writeCache(key, audio);
      return audio;
    } catch (error) {
      this.dropClient(voice);
      this.logger.error(
        `tts synthesis failed for voice "${voice}": ${(error as Error)?.message ?? error}`,
      );
      throw new BadGatewayException("tts synthesis failed");
    }
  }

  private async getClient(voice: string): Promise<MsEdgeTTS> {
    const active = this.clients.get(voice);
    if (active) {
      return active;
    }

    let pending = this.pendingClients.get(voice);
    if (!pending) {
      pending = this.createClient(voice).finally(() => {
        this.pendingClients.delete(voice);
      });
      this.pendingClients.set(voice, pending);
    }
    return pending;
  }

  private async createClient(voice: string): Promise<MsEdgeTTS> {
    const options: ConstructorParameters<typeof MsEdgeTTS>[0] = {};
    if (this.proxyUrl) {
      options.agent = new HttpsProxyAgent(this.proxyUrl);
    }
    const client = new MsEdgeTTS(options);
    try {
      await client.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    } catch (error) {
      this.destroyClient(voice, client);
      throw error;
    }
    this.clients.set(voice, client);
    return client;
  }

  private dropClient(voice: string) {
    const client = this.clients.get(voice);
    if (!client) {
      return;
    }
    this.clients.delete(voice);
    this.destroyClient(voice, client);
  }

  private destroyClient(voice: string, client: MsEdgeTTS) {
    try {
      client.close();
    } catch (error) {
      this.logger.debug(`failed to close tts client for "${voice}": ${error}`);
    }
  }

  private collectStream(stream: Readable): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let settled = false;
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        settled = true;
        resolve(Buffer.concat(chunks));
      });
      stream.on("error", (error) => {
        settled = true;
        reject(error);
      });
      stream.on("close", () => {
        if (!settled) {
          reject(new Error("audio stream closed before completion"));
        }
      });
    });
  }

  /** msedge-tts interpolates text into an SSML template unescaped, so we must do it here */
  private escapeSsml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  private async writeCache(key: string, data: Buffer): Promise<void> {
    await mkdir(this.storageDir, { recursive: true });
    const finalPath = join(this.storageDir, `${key}.mp3`);
    const tmpPath = join(this.storageDir, `${key}.${randomUUID()}.tmp`);
    try {
      await writeFile(tmpPath, data);
      await rename(tmpPath, finalPath);
    } catch (error) {
      await unlink(tmpPath).catch(() => undefined);
      throw error;
    }
  }
}

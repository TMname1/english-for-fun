import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { BadGatewayException, BadRequestException, INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import * as request from "supertest";

import { TtsController } from "../tts.controller";
import { TtsService } from "../tts.service";

const mockToStream = jest.fn();
const mockSetMetadata = jest.fn();
const mockClose = jest.fn();

jest.mock("msedge-tts", () => ({
  OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: "audio-24khz-48kbitrate-mono-mp3" },
  MsEdgeTTS: jest.fn().mockImplementation(() => ({
    setMetadata: mockSetMetadata,
    toStream: mockToStream,
    close: mockClose,
  })),
}));

function audioStreamOf(chunks: Buffer[]) {
  return { audioStream: Readable.from(chunks), metadataStream: null };
}

function failingStream() {
  const stream = new Readable({ read() {} });
  setImmediate(() => stream.destroy(new Error("socket boom")));
  return { audioStream: stream, metadataStream: null };
}

function delayedStream(chunk: Buffer, delayMs: number) {
  const stream = new Readable({ read() {} });
  setTimeout(() => {
    stream.push(chunk);
    stream.push(null);
  }, delayMs);
  return { audioStream: stream, metadataStream: null };
}

describe("tts", () => {
  let service: TtsService;
  let app: INestApplication;
  let storageDir: string;

  beforeEach(async () => {
    storageDir = await fs.mkdtemp(join(tmpdir(), "earthworm-tts-test-"));
    mockToStream.mockReset();
    mockSetMetadata.mockReset();
    mockClose.mockReset();
    mockSetMetadata.mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      controllers: [TtsController],
      providers: [
        TtsService,
        {
          provide: ConfigService,
          useValue: { get: (key: string) => (key === "TTS_STORAGE_DIR" ? storageDir : undefined) },
        },
      ],
    }).compile();

    service = moduleRef.get(TtsService);
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  describe("service", () => {
    it("synthesizes on cache miss and serves from disk afterwards", async () => {
      mockToStream.mockImplementation(() => audioStreamOf([Buffer.from("fake-mp3")]));

      const first = await service.getAudio("hello world", "American");
      expect(first.toString()).toBe("fake-mp3");
      expect(mockToStream).toHaveBeenCalledTimes(1);

      const files = await fs.readdir(storageDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^[0-9a-f]{64}\.mp3$/);

      const second = await service.getAudio("hello world", "American");
      expect(second.toString()).toBe("fake-mp3");
      expect(mockToStream).toHaveBeenCalledTimes(1);
    });

    it("caches per accent (voice is part of the key)", async () => {
      mockToStream.mockImplementation(() => audioStreamOf([Buffer.from("audio")]));

      await service.getAudio("same text", "American");
      await service.getAudio("same text", "British");

      expect(mockToStream).toHaveBeenCalledTimes(2);
      const files = await fs.readdir(storageDir);
      expect(files).toHaveLength(2);
    });

    it("rejects invalid text and accent with 400", async () => {
      await expect(service.getAudio("", "American")).rejects.toThrow(BadRequestException);
      await expect(service.getAudio(undefined, "American")).rejects.toThrow(BadRequestException);
      await expect(service.getAudio("   ", "American")).rejects.toThrow(BadRequestException);
      await expect(service.getAudio("a".repeat(501), "American")).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.getAudio("hello", "Canadian")).rejects.toThrow(BadRequestException);
      await expect(service.getAudio("hello", undefined)).rejects.toThrow(BadRequestException);
      expect(mockToStream).not.toHaveBeenCalled();
    });

    it("returns 502 without leaving files or broken clients when synthesis fails", async () => {
      mockToStream.mockImplementation(() => failingStream());

      await expect(service.getAudio("bad text", "American")).rejects.toThrow(BadGatewayException);
      expect(mockClose).toHaveBeenCalled();
      expect(await fs.readdir(storageDir)).toHaveLength(0);

      // the next request recreates the client and succeeds
      mockToStream.mockImplementation(() => audioStreamOf([Buffer.from("recovered")]));
      const audio = await service.getAudio("good text", "American");
      expect(audio.toString()).toBe("recovered");
    });

    it("returns 502 when the client cannot even be created", async () => {
      mockSetMetadata.mockRejectedValue(new Error("connect refused"));

      await expect(service.getAudio("any text", "American")).rejects.toThrow(BadGatewayException);
      expect(mockToStream).not.toHaveBeenCalled();
    });

    it("dedupes concurrent requests for the same text into one synthesis", async () => {
      mockToStream.mockImplementation(() => delayedStream(Buffer.from("dedup"), 30));

      const [a, b] = await Promise.all([
        service.getAudio("same concurrent", "American"),
        service.getAudio("same concurrent", "American"),
      ]);

      expect(mockToStream).toHaveBeenCalledTimes(1);
      expect(a.toString()).toBe("dedup");
      expect(b.toString()).toBe("dedup");
    });

    it("escapes xml-special characters in text", async () => {
      mockToStream.mockImplementation(() => audioStreamOf([Buffer.from("x")]));

      await service.getAudio('a & b < c > d "e"', "American");

      const sentText = mockToStream.mock.calls[0][0] as string;
      expect(sentText).toContain("&amp;");
      expect(sentText).toContain("&lt;");
      expect(sentText).toContain("&gt;");
      expect(sentText).not.toMatch(/a & b < c/);
    });
  });

  describe("http", () => {
    it("serves mp3 bytes with cacheable headers", async () => {
      mockToStream.mockImplementation(() => audioStreamOf([Buffer.from("http-mp3")]));

      const res = await request(app.getHttpServer())
        .get("/tts")
        .query({ text: "hello world", accent: "American" })
        .expect(200)
        .expect("Content-Type", /audio\/mpeg/)
        .expect("Cache-Control", "public, max-age=31536000, immutable");

      expect(Buffer.isBuffer(res.body)).toBe(true);
      expect(res.body.toString()).toBe("http-mp3");
    });

    it("maps validation errors to 400 and synthesis errors to 502", async () => {
      await request(app.getHttpServer())
        .get("/tts")
        .query({ text: "hi", accent: "Canadian" })
        .expect(400);
      await request(app.getHttpServer()).get("/tts").query({ accent: "American" }).expect(400);

      mockToStream.mockImplementation(() => failingStream());
      await request(app.getHttpServer())
        .get("/tts")
        .query({ text: "will fail", accent: "British" })
        .expect(502);
    });
  });
});

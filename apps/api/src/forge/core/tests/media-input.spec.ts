/**
 * 媒体入参校验单测：目标是「报错能自解释」，所以断言都盯在提示文案的关键信息上
 * （哪个文件、什么扩展名、支持哪些类型），而不是死扣整段字符串。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertMediaFile } from "../forge";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-media-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("assertMediaFile", () => {
  it("文件不存在：提示检查绝对路径与转义", async () => {
    const missing = join(dir, "nope.mp4");
    expect(() => assertMediaFile(missing)).toThrow(/文件不存在[\s\S]*绝对路径/);
  });

  it("传的是目录：明确说这是目录", async () => {
    const sub = join(dir, "folder.mp4");
    await mkdir(sub);
    expect(() => assertMediaFile(sub)).toThrow(/这是一个目录，不是媒体文件/);
  });

  it("0 字节文件：提示下载/导出未完成", async () => {
    const empty = join(dir, "empty.mp4");
    await writeFile(empty, "");
    expect(() => assertMediaFile(empty)).toThrow(/空的（0 字节）/);
  });

  it("文档扩展名：给出检测到的扩展名与支持清单（就是这次的 .md 场景）", async () => {
    const md = join(dir, "langfuse-prompt-config.md");
    await writeFile(md, "# hi");
    let message = "";
    try {
      assertMediaFile(md);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(md);
    expect(message).toContain("不是音视频文件（扩展名 .md）");
    expect(message).toContain("mp4/m4v/mkv/webm/mov/avi");
    expect(message).toContain("mp3/m4a/wav/aac");
  });

  it("无扩展名：提示「没有扩展名」而不是空白", async () => {
    const noExt = join(dir, "mystery");
    await writeFile(noExt, "x");
    expect(() => assertMediaFile(noExt)).toThrow(/没有扩展名/);
  });

  it("白名单内的音视频（扩展名大小写不敏感）直接放行", async () => {
    for (const name of ["a.mp4", "b.MP3", "c.wav", "d.M4A"]) {
      const file = join(dir, name);
      await writeFile(file, "x");
      expect(() => assertMediaFile(file)).not.toThrow();
    }
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { attachVideoContainer, currentMediaKind, setVideoControls, setVideoSource } from "../video";

/**
 * 单例媒体元素：音频只渲染 <audio> 播放条，视频渲染 <video>（默认隐藏控制栏）。
 * 模块级单例，测试之间靠 attachVideoContainer(null) 摘除元素，类型切换由 setVideoSource 触发重建。
 */
describe("englishSound video/media element", () => {
  let container: HTMLElement;
  const AUDIO_URL = "https://oss.test/course-video/song.mp3?X-Amz-Signature=abc";
  const VIDEO_URL = "https://oss.test/course-video/clip.mp4?X-Amz-Signature=abc";

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    attachVideoContainer(null);
    container.remove();
  });

  it("音频源渲染 <audio> 播放条，不出现 <video>", () => {
    attachVideoContainer(container);
    setVideoSource(AUDIO_URL);

    expect(container.querySelector("video")).toBeNull();
    const audio = container.querySelector("audio");
    expect(audio).not.toBeNull();
    expect(currentMediaKind()).toBe("audio");
    // 音频需要用户能直接操作，控制栏常显
    expect(audio!.controls).toBe(true);
    // 不铺黑色背景/高度，避免出现"黑块"
    expect(audio!.style.backgroundColor).toBe("");
    expect(audio!.style.maxHeight).toBe("");
  });

  it("音频上调用 setVideoControls(false) 仍保持控制栏可见", () => {
    attachVideoContainer(container);
    setVideoSource(AUDIO_URL);

    setVideoControls(false);

    expect(container.querySelector("audio")!.controls).toBe(true);
  });

  it("媒体类型切换时重建元素：视频 → 音频不残留 <video> 黑块", () => {
    attachVideoContainer(container);
    setVideoSource(VIDEO_URL);
    expect(container.querySelectorAll("video")).toHaveLength(1);

    setVideoSource(AUDIO_URL);

    expect(container.querySelectorAll("video")).toHaveLength(0);
    expect(container.querySelectorAll("audio")).toHaveLength(1);
    expect(currentMediaKind()).toBe("audio");
  });

  it("视频源只渲染 <video>，控制栏跟随悬停显隐", () => {
    attachVideoContainer(container);
    setVideoSource(VIDEO_URL);

    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video!.controls).toBe(false);

    setVideoControls(true);
    expect(video!.controls).toBe(true);
    setVideoControls(false);
    expect(video!.controls).toBe(false);
  });

  it("先设源后挂容器时，元素同样挂到容器里", () => {
    setVideoSource(AUDIO_URL);
    attachVideoContainer(container);

    expect(container.querySelectorAll("audio")).toHaveLength(1);
  });
});

import { existsSync } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@nestjs/common";

/**
 * multer 的落盘中转目录（旧 multipart 上传接口用；浏览器直传改造后仍保留兼容）。
 *
 * 请求被中断（客户端取消、或 Cloudflare 100s 超时掐断）时 multer 不会清理半截文件，
 * 线上就见过 3.8MB / 4.7MB 的 .mp3 残片留在容器 /tmp 里。这里起一个低频清扫兜底。
 */
export const UPLOAD_TMP_DIR = join(tmpdir(), "earthworm-uploads");

/** 残片保留时长：正常上传在秒级完成，留 2 小时足够排查又不会堆积 */
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

export async function ensureUploadTmpDir(): Promise<void> {
  if (!existsSync(UPLOAD_TMP_DIR)) {
    await mkdir(UPLOAD_TMP_DIR, { recursive: true });
  }
}

/** 删掉超过 2 小时没动过的中转文件，返回删除数量 */
export async function sweepUploadTmpDir(now = Date.now()): Promise<number> {
  await ensureUploadTmpDir();
  let removed = 0;
  for (const name of await readdir(UPLOAD_TMP_DIR)) {
    const path = join(UPLOAD_TMP_DIR, name);
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      if (now - info.mtimeMs < STALE_AFTER_MS) continue;
      await unlink(path);
      removed += 1;
    } catch {
      // 文件可能已被正常路径删除；清扫失败不应影响主流程
    }
  }
  return removed;
}

/** 启动即扫一次，之后每 30 分钟一次；返回停止函数（interval 已 unref，不阻塞退出） */
export function startUploadTmpSweeper(logger: Logger): () => void {
  const run = () => {
    void sweepUploadTmpDir()
      .then((removed) => {
        if (removed > 0) logger.log(`[forge:upload] 清理中断上传残留 ${removed} 个`);
      })
      .catch((error: unknown) => {
        logger.warn(`[forge:upload] 清理残留失败：${(error as Error)?.message ?? error}`);
      });
  };
  run();
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

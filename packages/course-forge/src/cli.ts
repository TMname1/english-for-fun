import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "./config";
import { forgeMake, paths } from "./forge";
import { forgeImport } from "./importer";

interface ParsedArgs {
  command: string;
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "forge", ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) {
      throw new Error(`无法识别的参数: ${arg}（用法见 --help）`);
    }
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[arg.slice(2)] = "true";
      } else {
        flags[arg.slice(2)] = next;
        i++;
      }
    }
  }
  return { command, flags };
}

function requireFlag(flags: Record<string, string>, name: string, usage: string): string {
  const value = flags[name];
  if (!value || value === "true") {
    throw new Error(`缺少必填参数 --${name}\n${usage}`);
  }
  return value;
}

/** --out 缺省时选择 output/ 下最近一次（名字最大）的运行目录 */
function resolveOutDir(flags: Record<string, string>): string {
  if (flags.out && flags.out !== "true") {
    return resolve(flags.out);
  }
  if (!existsSync(config.defaultOutRoot)) {
    throw new Error(
      `没有找到产物目录（${config.defaultOutRoot}），请先运行 forge，或用 --out 指定`,
    );
  }
  const runs = readdirSync(config.defaultOutRoot, { withFileTypes: true })
    .filter(
      (d) => d.isDirectory() && existsSync(resolve(config.defaultOutRoot, d.name, "meta.json")),
    )
    .map((d) => d.name)
    .sort();
  const last = runs[runs.length - 1];
  if (!last) {
    throw new Error(`output/ 下没有已完成的运行，请先运行 forge，或用 --out 指定`);
  }
  console.log(`[cli] 未指定 --out，使用最近一次运行: ${last}`);
  return resolve(config.defaultOutRoot, last);
}

const HELP = `Course Forge：视频/音频 -> 课程包流水线

用法：
  pnpm forge         -- --video <视频文件> --title <课程包名> [--type dialogue|music] [--desc 描述] [--language en] [--out 目录]
  pnpm forge         -- --audio <音频文件> ...    # 无视频来源时用音频（statement 不产出可播放的视频时间戳）
  pnpm forge:import  -- --out <目录>    # POST /course-pack 导入课程包（视频输入时会复制视频到 API 静态目录）

环境变量：
  FORGE_LLM_BASE_URL (默认 http://localhost:11434/v1)  FORGE_LLM_MODEL (默认 qwen3:4b)  FORGE_LLM_API_KEY
  FORGE_ASR_BASE_URL / FORGE_ASR_MODEL / FORGE_ASR_API_KEY（百炼 Qwen-Audio-ASR）   FORGE_API_URL (默认 http://localhost:3001)
  FORGE_COURSE_VIDEO_DIR (默认 apps/api/storage/course-video)  导入时视频复制目标目录
  FORGE_ASR_TIMEOUT_MS 单次转写超时（默认 3 分钟）       FORGE_LLM_PREFLIGHT=0 关闭 LLM 调用前预检
  FORGE_LLM_VRAM_STRICT=0 显存不足仅警告（CPU 卸载慢跑）  FORGE_LLM_VRAM_MARGIN_MB 显存估算余量（默认 512）
  FORGE_LLM_REASONING_EFFORT (默认 none，关闭 ollama 思考模式；非 ollama 服务如 DashScope 必须置空串)
  以上变量可写入 packages/course-forge/.env（见 .env.example；进程环境变量优先）。云端推荐：
  FORGE_LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1  FORGE_LLM_MODEL=qwen-plus`;

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (flags.help === "true") {
    console.log(HELP);
    return;
  }

  switch (command) {
    case "forge": {
      const type = flags.type === "music" ? "music" : "dialogue";
      const hasVideo = Boolean(flags.video) && flags.video !== "true";
      const hasAudio = Boolean(flags.audio) && flags.audio !== "true";
      if (!hasVideo && !hasAudio) {
        throw new Error(`缺少必填参数 --video 或 --audio\n${HELP}`);
      }
      await forgeMake({
        mediaPath: hasVideo ? flags.video : flags.audio,
        title: requireFlag(flags, "title", HELP),
        description: flags.desc,
        type,
        language: flags.language ?? "en",
        outDir: flags.out && flags.out !== "true" ? resolve(flags.out) : undefined,
      });
      return;
    }
    case "import": {
      const outDir = resolveOutDir(flags);
      if (!existsSync(paths.course(outDir))) {
        throw new Error(`[cli] ${outDir} 缺少 course.json，请先运行 forge`);
      }
      await forgeImport(outDir);
      return;
    }
    default:
      throw new Error(`未知命令: ${command}\n${HELP}`);
  }
}

main().catch((error) => {
  console.error(`\n[course-forge] 失败：${(error as Error).message}\n`);
  process.exit(1);
});

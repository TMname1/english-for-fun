import { spawnSync } from "node:child_process";
import path from "node:path";

const apiDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(apiDir, "../..");
const composeFile = path.join(repoRoot, "docker-compose.yml");

// CI 的 testdb 由 GitHub Actions service 容器提供，不能走本地 compose
const isCi = process.env.CI === "true";
const compose = `docker-compose -f "${composeFile}"`;

function sh(command: string, cwd: string): number {
  const result = spawnSync(command, { cwd, stdio: "inherit", shell: true });
  return result.status ?? 1;
}

function stopTestdb(): void {
  sh(`${compose} --profile test stop testdb`, repoRoot);
}

if (!isCi) {
  if (sh(`${compose} --profile test up -d --wait testdb`, repoRoot) !== 0) process.exit(1);
  if (sh("pnpm db:init:test", repoRoot) !== 0) {
    stopTestdb();
    process.exit(1);
  }
}

let exitCode = sh("pnpm test:unit", apiDir);
if (exitCode === 0) exitCode = sh("pnpm test:e2e", apiDir);

if (!isCi) stopTestdb();

process.exit(exitCode);
